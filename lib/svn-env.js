'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 所有 svn 子进程共用的环境变量。
 *
 * 除了固定的 UTF-8 locale（不设的话中文路径会被转成 {U+8DEF} 这种转义），
 * 还负责把 CA 根证书指给 OpenSSL —— 内嵌的 svn 用的是自建 OpenSSL，
 * 它编译时的 --openssldir 在用户机器上并不存在，不给 SSL_CERT_FILE
 * 就会把所有 https 仓库都判成"证书签发者不受信任"。
 */

// 打包后：Resources/ca/cacert.pem；开发时：<项目>/ca/cacert.pem
const APP_CA = path.join(__dirname, '..', 'ca', 'cacert.pem');
const SYSTEM_CA = '/etc/ssl/cert.pem';

function pickCaFile() {
  if (process.env.SSL_CERT_FILE && fs.existsSync(process.env.SSL_CERT_FILE)) {
    return process.env.SSL_CERT_FILE;
  }
  if (fs.existsSync(APP_CA)) return APP_CA;
  if (fs.existsSync(SYSTEM_CA)) return SYSTEM_CA;
  return null;
}

const CA_FILE = pickCaFile();

function svnEnv() {
  const env = {
    ...process.env,
    LC_ALL: 'en_US.UTF-8',
    LANG: 'en_US.UTF-8',
  };
  if (CA_FILE) env.SSL_CERT_FILE = CA_FILE;
  return env;
}

module.exports = { svnEnv, CA_FILE };
