import { Component, type ComponentType, type ReactNode, lazy, Suspense, useEffect } from "react"
import { SkulletProvider } from "skullet/react"
import { OpeningScreen } from "@/components/portal/screen-loading"
import { Gate } from "@/components/portal/gate"
import { DesktopLink } from "@/components/portal/desktop-link"
import { Elsewhere } from "@/components/portal/elsewhere"
import { Chat } from "@/components/portal/chat"
import { ChatSearch } from "@/components/portal/chat-search"
import { DrawerLayout } from "@/components/portal/drawer"
import { SettingsFrame, SettingsPlaceholder } from "@/components/portal/settings-frame"
import { Sidebar } from "@/components/portal/sidebar"
import { UpdatingScreen } from "@/components/portal/updating"
import { TooltipProvider } from "@/components/ui/tooltip"
import { usePortal } from "@/hooks/use-portal"
import { loadMarkdown, retryMarkdown } from "@/lib/markdown"

const resetScreens: (() => void)[] = []
const CHUNK_RELOAD = "nako-chunk-reload"

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; attempt: number }> {
  state = { error: null as Error | null, attempt: 0 }
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error(String(error)) } }
  componentDidCatch(error: unknown) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (!/ChunkLoadError|Loading (?:CSS )?chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message)) return
    try {
      if (sessionStorage.getItem(CHUNK_RELOAD)) return
      sessionStorage.setItem(CHUNK_RELOAD, "1")
      location.reload()
    } catch { /* Storage may be disabled; leave the manual recovery controls available. */ }
  }
  render() {
    if (this.state.error) return <main role="alert" className="flex min-h-dvh items-center justify-center gap-3 p-6 text-sm">
      <span>Something went wrong.</span>
      <button type="button" className="underline focus-visible:outline focus-visible:outline-ring" onClick={() => {
        resetScreens.forEach(reset => reset())
        void retryMarkdown().catch(() => {})
        this.setState(state => ({ error: null, attempt: state.attempt + 1 }))
      }}>Try again</button>
      <button type="button" className="underline focus-visible:outline focus-visible:outline-ring" onClick={() => location.reload()}>Reload</button>
    </main>
    return <div key={this.state.attempt} className="contents">{this.props.children}</div>
  }
}

/**
 * A screen kept out of the first download. Once its chunk is in, it renders straight away:
 * React.lazy suspends on its first render even then, and React holds a suspended screen's reveal
 * for up to 300 ms, which made Settings take a third of a second to open.
 */
function screen<P extends object>(load: () => Promise<ComponentType<P>>, fallback: (props: P) => ReactNode) {
  let loaded: ComponentType<P> | null = null
  const get = () => load().then(component => (loaded = component))
  const makeLazy = () => lazy(() => get().then(component => ({ default: component })))
  let Lazy = makeLazy()
  resetScreens.push(() => { loaded = null; Lazy = makeLazy() })
  function Screen(props: P) {
    const Loaded = loaded
    if (Loaded) return <Loaded {...props} />
    return (
      <Suspense fallback={fallback(props)}>
        <Lazy {...props} />
      </Suspense>
    )
  }
  return Object.assign(Screen, { preload: () => void get().catch(() => {}) })
}

const Settings = screen(() => import("@/components/portal/settings").then(m => m.Settings),
  ({ page, portal }) => <SettingsFrame page={page} hasEnvironments={Boolean(portal.me?.environments)}><SettingsPlaceholder page={page} /></SettingsFrame>)

// Settings is one tap away from every chat; fetch it once things are quiet so it opens at once.
function useWarmSettings(signedIn: boolean) {
  useEffect(() => {
    if (!signedIn) return
    if ("requestIdleCallback" in window) {
      const id = requestIdleCallback(Settings.preload, { timeout: 5000 })
      return () => cancelIdleCallback(id)
    }
    const timer = setTimeout(Settings.preload, 2000)
    return () => clearTimeout(timer)
  }, [signedIn])
}

export function App() {
  return <ErrorBoundary><SkulletProvider reveal="smart"><AppContent /><UpdatingScreen /></SkulletProvider></ErrorBoundary>
}

function AppContent() {
  const portal = usePortal()
  useWarmSettings(Boolean(portal.me?.signed_in))
  useEffect(() => {
    if (portal.me?.signed_in && portal.route.view !== "desktop") void loadMarkdown().catch(() => {})
  }, [portal.me?.signed_in, portal.route.view])
  if (!portal.me && !portal.error) return <OpeningScreen route={portal.route} />
  if (!portal.me) return (
    <main className="flex min-h-dvh items-center justify-center gap-3 p-6 text-sm">
      <div className="flex items-center gap-3" role="alert">
        <span>{portal.error}</span>
        <button type="button" className="underline" onClick={() => void portal.boot().catch(e => portal.setError((e as Error).message))}>Retry</button>
      </div>
    </main>
  )
  if (!portal.me.signed_in) return <Gate portal={portal} />
  if (portal.route.view === "desktop") return <DesktopLink query={portal.route.query} />
  return (
    <TooltipProvider>
      <DrawerLayout
        list={portal.route.view === "list"}
        sidebar={
          <Sidebar
            sessions={portal.sessions}
            sessionsState={portal.sessionsState}
            pin={portal.pin}
            archive={portal.archive}
            prefetch={portal.prefetch}
            setGroup={portal.setGroup}
            createGroup={portal.createGroup}
            updateGroup={portal.updateGroup}
            deleteGroup={portal.deleteGroup}
            setError={portal.setError}
            rename={portal.rename}
            route={portal.route}
            outside={portal.outside}
            connected={portal.connected}
            linked={portal.linked}
            hermes={portal.hermes}
            me={portal.me}
            currentSession={portal.current?.session}
            currentTitle={portal.current?.title}
            currentSource={portal.current?.source}
          />
        }
      >
        <main className="relative flex min-w-0 flex-1 flex-col">{portal.route.view === "settings" ? <Settings page={portal.route.page} portal={portal} /> : portal.route.view === "outside" ? <Elsewhere portal={portal} /> : <Chat portal={portal} />}</main>
      </DrawerLayout>
      <ChatSearch sessions={portal.sessions} unarchive={portal.unarchive} />

    </TooltipProvider>
  )
}
