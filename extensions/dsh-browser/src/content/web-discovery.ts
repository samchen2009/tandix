import { WEB_API_VERSION, WEB_DISCOVERY_REQUEST, WEB_DISCOVERY_RESPONSE, webRecord, webpageOrigin } from '../web-api/protocol.ts'

/** Discovery shares public identity only; task traffic and grants stay on the external Port. */
export function installWebDiscovery(target: Window, identity: () => { extensionId: string; extensionVersion: string }): () => void {
  if (target.top !== target || !webpageOrigin(target.location.href)) return () => {}
  const receive = (event: MessageEvent): void => {
    if (event.source !== target || event.origin !== target.location.origin || !webRecord(event.data)
      || event.data.type !== WEB_DISCOVERY_REQUEST || typeof event.data.requestId !== 'string'
      || !/^[a-f0-9-]{36}$/u.test(event.data.requestId)) return
    try {
      const info = identity()
      if (!/^[a-p]{32}$/u.test(info.extensionId)) return
      target.postMessage({ type: WEB_DISCOVERY_RESPONSE, requestId: event.data.requestId,
        product: 'tandix', version: WEB_API_VERSION, ...info }, target.location.origin)
    } catch { /* An invalidated extension context must not advertise a stale ID. */ }
  }
  target.addEventListener('message', receive)
  return () => target.removeEventListener('message', receive)
}
