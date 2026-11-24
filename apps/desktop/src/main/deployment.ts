const CLOUD_HOST = '472273737799.us-east1.run.app'

export type AssistantConfig =
  | { scope: 'local' }
  | { scope: 'remote' | 'dev' | 'prod'; baseUrl: string; token: string }

export function assistantConfig(env = process.env): AssistantConfig {
  const scope = env.OJOS_DEPLOY_SCOPE?.trim() || (env.OJOS_ASSISTANT_URL?.trim() ? 'remote' : 'local')
  if (scope === 'local') return { scope }
  if (scope !== 'dev' && scope !== 'prod' && scope !== 'remote') {
    throw new Error('Set OJOS_DEPLOY_SCOPE to local, dev, prod, or remote.')
  }
  const override = env.OJOS_ASSISTANT_URL?.trim()
  const endpoint = override || (scope === 'remote' ? '' : `https://ojos-${scope}-${CLOUD_HOST}`)
  if (!endpoint) throw new Error('Remote scope requires OJOS_ASSISTANT_URL.')
  const url = new URL(endpoint)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(scope === 'remote' && url.protocol === 'http:' && loopback))) {
    throw new Error('Use an HTTPS service origin or loopback HTTP with remote scope.')
  }
  const token = (scope === 'remote' ? env.OJOS_LOCAL_TOKEN : env.OJOS_CLOUD_TOKEN)?.trim()
  if (!token) throw new Error(`Set ${scope === 'remote' ? 'OJOS_LOCAL_TOKEN' : 'OJOS_CLOUD_TOKEN'} to connect Ojos.`)
  return { scope, baseUrl: url.origin, token }
}
