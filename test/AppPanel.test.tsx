import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import AppPanel from '../src/components/AppPanel'

interface AppInfo {
  index: number
  name: string
  appPath?: string
}

function mockFetchApps(apps: AppInfo[]): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: (): Promise<AppInfo[]> => Promise.resolve(apps),
  })
}

function mockFetchError(): void {
  global.fetch = jest.fn().mockRejectedValue(new Error('Network error'))
}

function mockFetchHttpError(status: number): void {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status })
}

describe('AppPanel', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  describe('loading state', () => {
    it('shows loading message while fetch is pending', () => {
      // fetch never resolves during this test
      global.fetch = jest.fn().mockReturnValue(new Promise(() => {}))
      render(<AppPanel />)
      expect(screen.getByText(/Loading/i)).toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('shows configure message when no apps are returned', async () => {
      mockFetchApps([])
      render(<AppPanel />)
      expect(await screen.findByText(/No web applications configured/i)).toBeInTheDocument()
    })

    it('shows error message when fetch fails', async () => {
      mockFetchError()
      render(<AppPanel />)
      expect(await screen.findByText(/Unable to load the application list/i)).toBeInTheDocument()
    })

    it('shows error message when server returns non-2xx', async () => {
      mockFetchHttpError(500)
      render(<AppPanel />)
      expect(await screen.findByText(/Unable to load the application list/i)).toBeInTheDocument()
    })
  })

  describe('single app', () => {
    const singleApp: AppInfo[] = [{ index: 0, name: 'Portainer CE' }]

    it('auto-selects and renders iframe when only one app is configured', async () => {
      mockFetchApps(singleApp)
      render(<AppPanel />)
      const iframe = await screen.findByTitle('Portainer CE')
      expect(iframe).toBeInTheDocument()
      expect(iframe.tagName).toBe('IFRAME')
    })

    it('iframe points to the correct proxy path', async () => {
      mockFetchApps(singleApp)
      render(<AppPanel />)
      const iframe = await screen.findByTitle('Portainer CE')
      expect(iframe).toHaveAttribute('src', '/plugins/signalk-embedded-webapp-proxy/proxy/0/')
    })

    it('does not render a dropdown for a single app', async () => {
      mockFetchApps(singleApp)
      render(<AppPanel />)
      await screen.findByTitle('Portainer CE') // wait for load
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    })

    it('iframe has sandbox attribute', async () => {
      mockFetchApps(singleApp)
      render(<AppPanel />)
      const iframe = await screen.findByTitle('Portainer CE')
      expect(iframe).toHaveAttribute(
        'sandbox',
        'allow-scripts allow-same-origin allow-forms allow-popups',
      )
    })

    it('iframe has referrerPolicy attribute', async () => {
      mockFetchApps(singleApp)
      render(<AppPanel />)
      const iframe = await screen.findByTitle('Portainer CE')
      expect(iframe).toHaveAttribute('referrerPolicy', 'no-referrer')
    })

    it('iframe uses appPath in src when available', async () => {
      mockFetchApps([{ index: 0, name: 'Portainer CE', appPath: 'portainer' }])
      render(<AppPanel />)
      const iframe = await screen.findByTitle('Portainer CE')
      expect(iframe).toHaveAttribute(
        'src',
        '/plugins/signalk-embedded-webapp-proxy/proxy/portainer/',
      )
    })

    it('iframe has no border', async () => {
      mockFetchApps(singleApp)
      render(<AppPanel />)
      const iframe = await screen.findByTitle('Portainer CE')
      expect(iframe).toHaveStyle({ borderWidth: '0' })
    })

    it('iframe fills available width', async () => {
      mockFetchApps(singleApp)
      render(<AppPanel />)
      const iframe = await screen.findByTitle('Portainer CE')
      expect(iframe).toHaveStyle({ width: '100%' })
    })
  })

  describe('multiple apps', () => {
    const twoApps: AppInfo[] = [
      { index: 0, name: 'Portainer CE' },
      { index: 1, name: 'Grafana' },
    ]

    it('renders a dropdown when multiple apps are configured', async () => {
      mockFetchApps(twoApps)
      render(<AppPanel />)
      expect(await screen.findByRole('combobox')).toBeInTheDocument()
    })

    it('dropdown lists all configured apps', async () => {
      mockFetchApps(twoApps)
      render(<AppPanel />)
      await screen.findByRole('combobox')
      expect(screen.getByRole('option', { name: 'Portainer CE' })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: 'Grafana' })).toBeInTheDocument()
    })

    it('does not render an iframe before an app is selected', async () => {
      mockFetchApps(twoApps)
      render(<AppPanel />)
      await screen.findByRole('combobox')
      expect(screen.queryByTitle('Portainer CE')).not.toBeInTheDocument()
      expect(screen.queryByTitle('Grafana')).not.toBeInTheDocument()
    })

    it('shows select prompt before selection', async () => {
      mockFetchApps(twoApps)
      render(<AppPanel />)
      expect(await screen.findByText(/Select an application above/i)).toBeInTheDocument()
    })

    it('renders iframe with correct src after selecting an app', async () => {
      mockFetchApps(twoApps)
      render(<AppPanel />)
      const select = await screen.findByRole('combobox')

      act(() => {
        fireEvent.change(select, { target: { value: '1' } })
      })

      const iframe = screen.getByTitle('Grafana')
      expect(iframe).toBeInTheDocument()
      expect(iframe).toHaveAttribute('src', '/plugins/signalk-embedded-webapp-proxy/proxy/1/')
    })

    it('iframe title matches the selected app name', async () => {
      mockFetchApps(twoApps)
      render(<AppPanel />)
      const select = await screen.findByRole('combobox')

      act(() => {
        fireEvent.change(select, { target: { value: '0' } })
      })

      expect(screen.getByTitle('Portainer CE')).toBeInTheDocument()
    })

    it('swaps iframe when a different app is selected', async () => {
      mockFetchApps(twoApps)
      render(<AppPanel />)
      const select = await screen.findByRole('combobox')

      act(() => {
        fireEvent.change(select, { target: { value: '0' } })
      })
      expect(screen.getByTitle('Portainer CE')).toHaveAttribute(
        'src',
        '/plugins/signalk-embedded-webapp-proxy/proxy/0/',
      )

      act(() => {
        fireEvent.change(select, { target: { value: '1' } })
      })
      expect(screen.queryByTitle('Portainer CE')).not.toBeInTheDocument()
      expect(screen.getByTitle('Grafana')).toHaveAttribute(
        'src',
        '/plugins/signalk-embedded-webapp-proxy/proxy/1/',
      )
    })
  })

  describe('toolbar auto-hide', () => {
    const twoApps: AppInfo[] = [
      { index: 0, name: 'Portainer CE' },
      { index: 1, name: 'Grafana' },
    ]

    it('toolbar is visible initially before any selection', async () => {
      mockFetchApps(twoApps)
      render(<AppPanel />)
      await screen.findByRole('combobox')
      const toolbar = screen.getByTestId('toolbar')
      expect(toolbar).toHaveStyle({ top: '0px' })
    })

    it('toolbar hides after selecting an app and timeout elapses', async () => {
      mockFetchApps(twoApps)
      render(<AppPanel />)
      const select = await screen.findByRole('combobox')

      act(() => {
        fireEvent.change(select, { target: { value: '0' } })
      })

      // Toolbar still visible immediately after selection
      expect(screen.getByTestId('toolbar')).toHaveStyle({ top: '0px' })

      // Advance past auto-hide delay
      act(() => {
        jest.advanceTimersByTime(3000)
      })

      expect(screen.getByTestId('toolbar')).toHaveStyle({ top: '-40px' })
    })

    it('hot zone appears when toolbar is hidden', async () => {
      mockFetchApps(twoApps)
      render(<AppPanel />)
      const select = await screen.findByRole('combobox')

      // No hot zone while toolbar is visible
      expect(screen.queryByTestId('hot-zone')).not.toBeInTheDocument()

      act(() => {
        fireEvent.change(select, { target: { value: '0' } })
      })
      act(() => {
        jest.advanceTimersByTime(3000)
      })

      // Hot zone appears when toolbar is hidden
      expect(screen.getByTestId('hot-zone')).toBeInTheDocument()
    })

    it('hovering over hot zone reveals toolbar', async () => {
      mockFetchApps(twoApps)
      render(<AppPanel />)
      const select = await screen.findByRole('combobox')

      act(() => {
        fireEvent.change(select, { target: { value: '0' } })
      })
      act(() => {
        jest.advanceTimersByTime(3000)
      })

      // Toolbar is hidden
      expect(screen.getByTestId('toolbar')).toHaveStyle({ top: '-40px' })

      // Hover over hot zone
      act(() => {
        fireEvent.mouseEnter(screen.getByTestId('hot-zone'))
      })

      // Toolbar reappears
      expect(screen.getByTestId('toolbar')).toHaveStyle({ top: '0px' })
    })

    it('toolbar stays visible while mouse is over it', async () => {
      mockFetchApps(twoApps)
      render(<AppPanel />)
      const select = await screen.findByRole('combobox')

      act(() => {
        fireEvent.change(select, { target: { value: '0' } })
      })

      // Mouse enters toolbar — should cancel hide timer
      act(() => {
        fireEvent.mouseEnter(screen.getByTestId('toolbar'))
      })

      // Advance well past the hide delay
      act(() => {
        jest.advanceTimersByTime(10000)
      })

      // Toolbar still visible
      expect(screen.getByTestId('toolbar')).toHaveStyle({ top: '0px' })
    })

    it('toolbar hides after mouse leaves it', async () => {
      mockFetchApps(twoApps)
      render(<AppPanel />)
      const select = await screen.findByRole('combobox')

      act(() => {
        fireEvent.change(select, { target: { value: '0' } })
      })

      act(() => {
        fireEvent.mouseEnter(screen.getByTestId('toolbar'))
      })
      act(() => {
        fireEvent.mouseLeave(screen.getByTestId('toolbar'))
      })

      // Not hidden yet
      expect(screen.getByTestId('toolbar')).toHaveStyle({ top: '0px' })

      // Advance past delay
      act(() => {
        jest.advanceTimersByTime(3000)
      })

      expect(screen.getByTestId('toolbar')).toHaveStyle({ top: '-40px' })
    })

    it('does not show toolbar or hot zone for single app', async () => {
      mockFetchApps([{ index: 0, name: 'Portainer CE' }])
      render(<AppPanel />)
      await screen.findByTitle('Portainer CE')
      expect(screen.queryByTestId('toolbar')).not.toBeInTheDocument()
      expect(screen.queryByTestId('hot-zone')).not.toBeInTheDocument()
    })
  })

  describe('fetch URL', () => {
    it('fetches apps from the correct endpoint', async () => {
      mockFetchApps([])
      render(<AppPanel />)
      await screen.findByText(/No web applications configured/i)
      expect(global.fetch).toHaveBeenCalledWith(
        '/plugins/signalk-embedded-webapp-proxy/apps',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
  })
})
