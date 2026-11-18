import type { ChipColor } from '@/components/base/badges/chip';
import type { ChangeKind } from '@/src/lib/types';

/**
 * 状态语义：字母 + 颜色 + 中文标签三重编码。
 * 不靠颜色单独传递信息（色盲可读），颜色只做加速识别。
 */
export interface KindMeta {
  letter: string;
  label: string;
  tone: ChipColor;
  /** 列表左侧字母块的自定义底色类，保证深色主题下也清晰 */
  blockClass: string;
}

export const KIND_META: Record<ChangeKind, KindMeta> = {
  modified: {
    letter: 'M',
    label: '已修改',
    tone: 'blue',
    blockClass: 'bg-accent-100 text-accent-700 dark:bg-accent-500/20 dark:text-accent-300',
  },
  added: {
    letter: 'A',
    label: '新增',
    tone: 'lime',
    blockClass: 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400',
  },
  deleted: {
    letter: 'D',
    label: '已删除',
    tone: 'rose',
    blockClass: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400',
  },
  replaced: {
    letter: 'R',
    label: '已替换',
    tone: 'purple',
    blockClass: 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300',
  },
  conflicted: {
    letter: 'C',
    // 冲突是"必须先处理才能提交"的状态，用红色和其它黄色提醒区分开
    label: '有冲突',
    tone: 'rose',
    blockClass: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400',
  },
  unversioned: {
    letter: '?',
    label: '未纳入版本管理',
    tone: 'yellow',
    blockClass: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  },
  missing: {
    // 本地被删掉、但还没 svn delete：视觉上跟「已删除」同一套语言，
    // 标签点明是本地删除，避免误以为已经排进提交
    letter: 'D',
    label: '本地已删除',
    tone: 'rose',
    blockClass: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400',
  },
  ignored: {
    letter: 'I',
    label: '已忽略',
    tone: 'gray',
    blockClass: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300',
  },
  external: {
    letter: 'X',
    label: '外部引用',
    tone: 'cyan',
    blockClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-300',
  },
  normal: {
    letter: '·',
    label: '无变化',
    tone: 'neutral',
    blockClass: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300',
  },
};

export function kindMeta(kind: string): KindMeta {
  return KIND_META[kind as ChangeKind] ?? KIND_META.normal;
}

/** 可提交的状态（ignored / normal 不进提交清单） */
export const COMMITTABLE: ChangeKind[] = [
  'modified',
  'added',
  'deleted',
  'replaced',
  'conflicted',
  'unversioned',
  'missing',
];
