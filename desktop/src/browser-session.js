/** External pages never inherit the portal's cookies or native permissions. */
export const BROWSER_PARTITION = "persist:external-browser"

export function restrictBrowserSession(session) {
  session.setPermissionRequestHandler((_page, _permission, respond) => respond(false))
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  return session
}
