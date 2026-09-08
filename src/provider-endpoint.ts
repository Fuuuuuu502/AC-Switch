export function endpointForProtocol(endpoint: string, protocol: string): string {
  // Only replace known API suffixes; preserve custom routes and query strings.
  try {
    const url = new URL(endpoint.trim());
    if (/\/(chat\/completions|responses)\/?$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/(chat\/completions|responses)\/?$/, protocol === 'responses' ? '/responses' : '/chat/completions');
      return url.toString();
    }
  } catch { /* Keep unfinished input for validation in the form. */ }
  return endpoint;
}

export function endpointError(endpoint: string, protocol: string): string {
  let url: URL;
  try { url = new URL(endpoint.trim()); } catch { return '请填写完整的 HTTP 或 HTTPS 请求地址。'; }
  if (!['http:', 'https:'].includes(url.protocol)) return '接口地址必须使用 HTTP 或 HTTPS。';
  if (url.username || url.password || url.hash) return '接口地址不能包含账号、密码或 # 片段；密钥请填入 API Key。';
  const path = url.pathname.replace(/\/+$/, '');
  if (/(^|\/)anthropic(\/|$)/i.test(path) || /\/messages$/.test(path)) return '这是 Anthropic Messages 接口，当前尚不支持。DeepSeek 请使用预设的 Chat Completions 地址。';
  if (!path || path === '/v1') return '这里需要完整请求地址，不能只填基础地址。请在地址后补上 /chat/completions 或 /responses，与所选协议对应。';
  if (protocol === 'responses' && /\/chat\/completions$/.test(path)) return '当前选择 Responses，请将请求地址改为对应的 /responses 接口。';
  if (protocol !== 'responses' && /\/responses$/.test(path)) return '当前选择 Chat Completions，请使用对应的 /chat/completions 接口。';
  return '';
}
