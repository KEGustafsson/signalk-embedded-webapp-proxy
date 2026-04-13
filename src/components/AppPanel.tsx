import React from 'react'

const PLUGIN_PATH = '/plugins/signalk-embedded-webapp-proxy'

// Height in pixels of the SignalK admin UI top navigation bar.
// The panel fills the remaining viewport height below it.
const ADMIN_HEADER_HEIGHT = 64

// Toolbar auto-hide settings
const TOOLBAR_HEIGHT = 40
const HOT_ZONE_HEIGHT = 6 // invisible hover strip that triggers reveal
const AUTO_HIDE_DELAY = 3000 // ms before toolbar retracts after mouse leaves

interface AppInfo {
  index: number
  name: string
  appPath?: string
}

const msgStyle: React.CSSProperties = {
  padding: '16px',
  fontFamily: 'sans-serif',
}

const AppPanel: React.FC = () => {
  const [apps, setApps] = React.useState<AppInfo[]>([])
  const [selected, setSelected] = React.useState<number | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [barVisible, setBarVisible] = React.useState(true)
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearHideTimer = React.useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }, [])

  const scheduleHide = React.useCallback(() => {
    clearHideTimer()
    hideTimer.current = setTimeout(() => setBarVisible(false), AUTO_HIDE_DELAY)
  }, [clearHideTimer])

  // Clean up timer on unmount
  React.useEffect(() => clearHideTimer, [clearHideTimer])

  // Start auto-hide timer once an app is selected
  React.useEffect(() => {
    if (selected !== null) {
      scheduleHide()
    }
  }, [selected, scheduleHide])

  React.useEffect(() => {
    fetch(`${PLUGIN_PATH}/apps`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${String(r.status)}`)
        return r.json() as Promise<AppInfo[]>
      })
      .then((data) => {
        setApps(data)
        // Auto-select the only app so the iframe loads immediately
        if (data.length === 1) setSelected(data[0]?.index ?? 0)
      })
      .catch(() => {
        // Leave apps empty — the empty-state message will be shown
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div style={msgStyle}>Loading…</div>
  }

  if (apps.length === 0) {
    return (
      <div style={msgStyle}>
        No web applications configured. Add applications in the plugin settings.
      </div>
    )
  }

  const selectedApp = apps.find((a) => a.index === selected) ?? null
  const showToolbar = apps.length > 1

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: `calc(100vh - ${ADMIN_HEADER_HEIGHT}px)`,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {showToolbar && (
        <>
          {/* Invisible hot zone at top — reveals toolbar on hover */}
          {!barVisible && (
            <div
              data-testid="hot-zone"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: `${HOT_ZONE_HEIGHT}px`,
                zIndex: 20,
                cursor: 'default',
              }}
              onMouseEnter={() => {
                clearHideTimer()
                setBarVisible(true)
              }}
            />
          )}
          {/* Sliding toolbar */}
          <div
            data-testid="toolbar"
            style={{
              position: 'absolute',
              top: barVisible ? 0 : -TOOLBAR_HEIGHT,
              left: 0,
              right: 0,
              height: `${TOOLBAR_HEIGHT}px`,
              display: 'flex',
              alignItems: 'center',
              padding: '0 12px',
              borderBottom: '1px solid #ddd',
              background: '#fff',
              zIndex: 10,
              transition: 'top 0.25s ease-in-out',
            }}
            onMouseEnter={clearHideTimer}
            onMouseLeave={scheduleHide}
          >
            <select
              value={selected ?? ''}
              onChange={(e) => setSelected(Number(e.target.value))}
              aria-label="Select application"
            >
              <option value="" disabled>
                Select an application…
              </option>
              {apps.map((appItem) => (
                <option key={appItem.index} value={appItem.index}>
                  {appItem.name}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      {selectedApp !== null ? (
        <iframe
          key={selected}
          src={`${PLUGIN_PATH}/proxy/${selectedApp.appPath ?? selected}/`}
          style={{
            flex: 1,
            width: '100%',
            borderWidth: 0,
            // Shift down when toolbar is visible to avoid overlap
            marginTop: showToolbar && barVisible ? `${TOOLBAR_HEIGHT}px` : 0,
            transition: 'margin-top 0.25s ease-in-out',
          }}
          title={selectedApp.name}
          // allow-same-origin lets cookie/session auth work in proxied apps (e.g. Portainer).
          // Trade-off: proxied content runs at the SignalK admin origin. Only proxy trusted apps.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div style={msgStyle}>Select an application above.</div>
      )}
    </div>
  )
}

export default AppPanel
