/**
 * realhuman/providers/volc-sign.js
 *
 * 火山引擎 OpenAPI V4 签名（HMAC-SHA256），属 omnihuman 区域的私有 helper。
 *
 * 火山的鉴权不是 Bearer token，而是「每个请求现签」：
 * 用 AK/SK 对请求的方法、路径、Query、部分头、body 哈希做一条 HMAC 链，
 * 算出 Authorization 头。算法与 AWS SigV4 同源，但有两处不同要当心：
 *   1. CredentialScope 结尾是字符串 "request"（不是 AWS 的 "aws4_request"）
 *   2. HMAC 链的起始密钥直接用 SK 原文（不加 "AWS4" 之类前缀）
 *
 * 只依赖 Node 内置 crypto，零外部依赖。
 * 参考：官方签名规范 https://www.volcengine.com/docs/6369/67268
 */

import crypto from 'node:crypto';

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * RFC3986 编码：encodeURIComponent 之外再补编 !'()*
 *（Query 参与签名，编码方式和服务端必须逐字节一致，否则报 Invalid Authorization）
 */
function uriEscape(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * 对一次火山 OpenAPI 请求做 V4 签名，返回可直接 fetch 的 url + headers。
 *
 * 注意：bodyString 必须就是最终发送的那个字符串（同一个 JSON.stringify 产物），
 * 签名里含 body 的 sha256，发出去的 body 与签名时不一致就是 400 Invalid Authorization。
 *
 * @param {{
 *   accessKeyId: string,
 *   secretAccessKey: string,
 *   query: Record<string,string>,   // 如 { Action: 'CVSubmitTask', Version: '2022-08-31' }
 *   bodyString: string,             // JSON.stringify(body) 的结果
 *   host?: string, region?: string, service?: string,
 * }} opts
 * @returns {{ url: string, headers: Record<string,string> }}
 */
export function signVolcRequest({
  accessKeyId,
  secretAccessKey,
  query,
  bodyString,
  host = 'visual.volcengineapi.com',
  region = 'cn-north-1',
  service = 'cv',
}) {
  // X-Date：UTC 紧凑 ISO8601（形如 20260611T120000Z）。⚠️ 用本地时区是常见 400 原因
  const xDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = xDate.slice(0, 8);
  const bodySha = sha256Hex(bodyString);

  // CanonicalQueryString：按 key 字典序，key/value 均 RFC3986 编码
  const queryString = Object.keys(query)
    .sort()
    .map((k) => `${uriEscape(k)}=${uriEscape(String(query[k]))}`)
    .join('&');

  // 参与签名的头：host + x-content-sha256 + x-date（官方 SDK 习惯的最稳组合；
  // 社区最小实现只签 x-date 也被服务端接受，这里取更稳的全集）
  const headerMap = {
    host,
    'x-content-sha256': bodySha,
    'x-date': xDate,
  };
  const signedHeaderNames = Object.keys(headerMap).sort();
  const signedHeaders = signedHeaderNames.join(';');
  // 每行「小写名:trim后的值」+ 换行，整块末尾补一个空行（AWS SigV4 同款格式）
  const canonicalHeaders =
    signedHeaderNames.map((k) => `${k}:${String(headerMap[k]).trim()}`).join('\n') + '\n';

  const canonicalRequest = [
    'POST',
    '/',
    queryString,
    canonicalHeaders,
    signedHeaders,
    bodySha,
  ].join('\n');

  // ⚠️ 结尾是 "request"，不是 AWS 的 "aws4_request"
  const credentialScope = `${date}/${region}/${service}/request`;
  const stringToSign = [
    'HMAC-SHA256',
    xDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  // HMAC 派生链：SK 原文 → date → region → service → "request"
  const kDate = hmac(secretAccessKey, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  return {
    url: `https://${host}/?${queryString}`,
    headers: {
      'X-Date': xDate,
      'X-Content-Sha256': bodySha,
      'Content-Type': 'application/json',
      'Authorization': `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}
