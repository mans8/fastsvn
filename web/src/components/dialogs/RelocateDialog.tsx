import { useEffect, useState } from 'react';
import { RiAlertLine, RiArrowRightLine } from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { Input } from '@/components/base/input/input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/base/modal/modal';
import { toast } from '@/components/base/toast/toast';
import { api, decodePercent, type SvnCreds } from '@/src/lib/api';
import { canonicalUrl, prettyUrl } from '@/src/lib/format';
import type { WcRepoInfo } from '@/src/lib/types';

export interface RelocateTarget {
  path: string;
  name: string;
}

interface Props {
  /** null 表示关闭；打开时用 path 读取当前地址并预填 */
  target: RelocateTarget | null;
  onOpenChange: (open: boolean) => void;
  onDone: (result: { path: string; oldUrl: string; newUrl: string }) => void;
}

/**
 * 修改仓库地址 = svn relocate：只处理"同一个仓库换了地址"。
 * 换仓库（UUID 不同）和换路径（等于切换分支）都会被后端预检拒绝。
 */
export function RelocateDialog({ target, onOpenChange, onDone }: Props) {
  const [info, setInfo] = useState<WcRepoInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  // 新地址要账号：在同一对话框里补登录，别把用户踢去「浏览仓库」
  const [needsAuth, setNeedsAuth] = useState(false);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [pending, setPending] = useState(false);
  // 命令失败但地址已经改过去：给一个"还原为原地址"的出口
  const [semi, setSemi] = useState<{ currentUrl: string; error: string } | null>(null);

  const path = target?.path ?? null;

  useEffect(() => {
    if (!path) {
      setInfo(null);
      setValue('');
      setLoadError(null);
      setError(null);
      setNeedsAuth(false);
      setUser('');
      setPass('');
      setSemi(null);
      setPending(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setInfo(null);
    setLoadError(null);
    setError(null);
    setSemi(null);
    api
      .workingCopyInfo(path)
      .then((data) => {
        if (!alive) return;
        setInfo(data);
        // svn 输出的是百分号编码：预填成中文，用户才能看懂自己在改哪一段
        setValue(prettyUrl(data.url));
      })
      .catch((e) => {
        if (!alive) return;
        setLoadError(decodePercent((e as Error).message));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [path]);

  const credsInput = (): SvnCreds | null =>
    user.trim() ? { username: user.trim(), password: pass } : null;

  const run = async (url: string, mode: 'relocate' | 'revert') => {
    if (!path) return;
    // 用户看到的/填的是中文地址：提交前统一成 svn 认的百分号编码形式
    const sendUrl = canonicalUrl(url);
    setPending(true);
    setError(null);
    setSemi(null);
    try {
      const r = await api.relocateWorkingCopy(path, sendUrl, credsInput());
      if (r.ok) {
        onDone({ path, oldUrl: r.oldUrl, newUrl: r.newUrl });
        onOpenChange(false);
        if (mode === 'revert') {
          toast('已还原为原地址', { description: prettyUrl(r.newUrl), status: 'success' });
        } else {
          toast('已修改仓库地址', {
            description: `${prettyUrl(r.oldUrl)} → ${prettyUrl(r.newUrl)}`,
            status: 'success',
          });
        }
        return;
      }
      if (r.needsAuth) {
        setNeedsAuth(true);
        setError(r.error ?? '这个仓库需要账号密码');
        return;
      }
      if (
        r.stage === 'verify' &&
        r.currentUrl &&
        canonicalUrl(r.currentUrl) === canonicalUrl(r.newUrl)
      ) {
        setSemi({ currentUrl: prettyUrl(r.currentUrl), error: r.error ?? '地址已经改过去，但校验没有通过' });
        return;
      }
      if (r.stage === 'precheck') {
        // 预检失败：工作副本没动过，留在对话框里改地址重试
        setError(r.error ?? '预检没有通过');
        return;
      }
      // 已经动过工作副本：不适合继续在表单里重试，直接告知并关窗
      toast(mode === 'revert' ? '还原失败' : '重定向失败', {
        description: r.error ?? '未知原因',
        status: 'error',
      });
      onOpenChange(false);
    } catch (e) {
      setError(decodePercent((e as Error).message));
    } finally {
      setPending(false);
    }
  };

  const submit = () => {
    const url = value.trim();
    if (!url) {
      setError('填一个要重定向到的新地址');
      return;
    }
    void run(url, 'relocate');
  };

  const currentUrl = prettyUrl(info?.url ?? '');
  const normalizedInput = value.trim().replace(/\/+$/, '');
  const changed = Boolean(info) && normalizedInput !== '' && normalizedInput !== currentUrl;

  return (
    <Modal
      isOpen={Boolean(target)}
      onOpenChange={onOpenChange}
      size="md"
      className="min-w-[520px]"
    >
      <ModalHeader
        title="修改仓库地址"
        description="仓库换了地址（域名、端口或服务器路径）时用这里。只改工作副本记录的地址，本地文件不会动。"
      />
      <ModalBody>
        {loading && (
          <p className="text-caption-1-regular text-text-tertiary">正在读取当前地址…</p>
        )}
        {loadError && (
          <p className="flex items-start gap-1.5 text-caption-1-regular text-text-error-primary">
            <RiAlertLine className="mt-px size-3.5 shrink-0" />
            {loadError}
          </p>
        )}
        {info && (
          <>
            <p className="text-caption-2-semibold tracking-wide text-text-tertiary uppercase">当前地址</p>
            <p
              dir="ltr"
              className="mt-1 rounded-lg bg-background-secondary-default px-3 py-2 text-start font-mono text-[12px] break-all text-text-secondary"
            >
              {currentUrl}
            </p>

            <div className="mt-3">
              <Input
                label="新的仓库地址"
                placeholder={currentUrl}
                inputClassName="font-mono text-[12px]"
                value={value}
                onChange={(next) => setValue(next)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                }}
                autoFocus
                isInvalid={Boolean(error)}
              />
            </div>

            {changed && (
              <p className="mt-2 flex flex-wrap items-center gap-1 text-caption-2-regular text-text-tertiary">
                <bdi dir="ltr" className="font-mono text-[11px]">
                  {currentUrl}
                </bdi>
                <RiArrowRightLine className="size-3 shrink-0" />
                <bdi dir="ltr" className="font-mono text-[11px] text-text-secondary">
                  {normalizedInput}
                </bdi>
              </p>
            )}

            {error && (
              <p className="mt-2 flex items-start gap-1.5 text-caption-1-regular text-text-error-primary">
                <RiAlertLine className="mt-px size-3.5 shrink-0" />
                {error}
              </p>
            )}

            {needsAuth && (
              <div className="mt-2 flex flex-col gap-1.5 rounded-lg bg-background-secondary-default px-3 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="w-[150px]">
                    <Input
                      aria-label="SVN 用户名"
                      placeholder="用户名"
                      value={user}
                      onChange={(next) => setUser(next)}
                    />
                  </div>
                  <div className="w-[150px]">
                    <Input
                      aria-label="SVN 密码"
                      type="password"
                      placeholder="密码"
                      value={pass}
                      onChange={(next) => setPass(next)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && user.trim()) submit();
                      }}
                    />
                  </div>
                  <Button variant="secondary" size="small" disabled={!user.trim() || pending} onClick={submit}>
                    重试
                  </Button>
                </div>
                <span className="text-caption-2-regular text-text-tertiary">
                  凭据会安全保存在 macOS 钥匙串，下次不用再输
                </span>
              </div>
            )}

            {semi && (
              <div className="mt-3 rounded-lg border border-border-error-default bg-background-secondary-default px-3 py-2">
                <p className="flex items-start gap-1.5 text-caption-1-regular text-text-error-primary">
                  <RiAlertLine className="mt-px size-3.5 shrink-0" />
                  {semi.error}
                </p>
                <p className="mt-1 text-caption-2-regular text-text-tertiary">
                  工作副本现在指向 <bdi dir="ltr" className="font-mono">{semi.currentUrl}</bdi>
                </p>
                <Button
                  variant="secondary"
                  size="small"
                  className="mt-2"
                  disabled={pending}
                  onClick={() => void run(currentUrl, 'revert')}
                >
                  {pending ? '正在还原…' : '还原为原地址'}
                </Button>
              </div>
            )}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button
          variant="primary"
          disabled={pending || loading || !info || !value.trim()}
          onClick={submit}
        >
          {pending ? '正在重定向…' : '重定向'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
