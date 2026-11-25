export function accountReturn(value: string | null | undefined) {
  return value && /^\/(?:products\/[a-z0-9-]{1,40}|orders\/[0-9a-f-]{36}|staff)$/.test(value) ? value : '/account';
}
