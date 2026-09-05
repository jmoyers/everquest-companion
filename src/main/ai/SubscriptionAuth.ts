import { BrowserWindow, session } from 'electron'

export class SubscriptionAuth {
  private authWindow: BrowserWindow | null = null

  /**
   * Spawns an off-screen or modal window to authenticate against EQ Companion Pro.
   * Extracts the session cookie upon successful login.
   */
  public async extractSubscriptionCookie(): Promise<string | null> {
    return new Promise((resolve) => {
      this.authWindow = new BrowserWindow({
        width: 400,
        height: 600,
        show: false, // Spawn invisible for now, or true if we want the user to type
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      })

      // We load the hypothetical subscription portal
      void this.authWindow.loadURL('https://everquestcompanion.com/login')

      this.authWindow.webContents.on('did-navigate', (_event, url) => {
        if (!url.includes('/dashboard')) return
        void session.defaultSession.cookies.get({ url: 'https://everquestcompanion.com' }).then((cookies) => {
          const sessionCookie = cookies.find((c) => c.name === 'eqc_session')
          if (this.authWindow) {
            this.authWindow.close()
            this.authWindow = null
          }
          resolve(sessionCookie ? sessionCookie.value : null)
        })
      })

      this.authWindow.on('closed', () => {
        this.authWindow = null
        resolve(null)
      })
    })
  }
}
