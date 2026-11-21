const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, powerMonitor, screen, session } = require('electron');
const path = require('node:path');
const { Recorder, writeBundle } = require('./recorder.cjs');

const recorder = new Recorder();
const clockUs = () => Math.round(performance.now() * 1000);
const portal = process.platform === 'linux' &&
  (process.env.XDG_SESSION_TYPE === 'wayland' ||
    (process.env.XDG_SESSION_TYPE !== 'x11' && !!process.env.WAYLAND_DISPLAY));
const screenSources = () => desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
let window;
let sources = [];
let chosenSource;
let sessionStart;
let exporting = false;

function stop(sessionId) {
  if (sessionId === recorder.sessionId) {
    recorder.stop();
    chosenSource = undefined;
  }
}

function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!window || event.senderFrame !== window.webContents.mainFrame) throw new Error('Invalid capture client.');
    return callback(...args);
  });
}

app.whenReady().then(async () => {
  app.setName('Ojos Capture');
  window = new BrowserWindow({
    width: 480, height: 340, minWidth: 350, minHeight: 310, title: 'Ojos Capture',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      sandbox: true, backgroundThrottling: false
    }
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const active = recorder.sessionId;
    if (!active || request.frame !== window?.webContents.mainFrame || !request.videoRequested || request.audioRequested) {
      callback({});
      return;
    }
    try {
      const source = portal ? (await screenSources())[0] : chosenSource;
      callback(source && active === recorder.sessionId ? { video: source } : {});
    } catch {
      callback({});
    }
  });

  handle('capture:sources', async () => {
    sources = portal ? [] : await screenSources();
    return { portal, displays: sources.map(source => ({ id: source.id, name: source.name })) };
  });
  handle('capture:clock', clockUs);
  handle('capture:start', sourceId => {
    if (recorder.sessionId) throw new Error('A session is already active.');
    chosenSource = sources.find(source => source.id === sourceId);
    if (!portal && !chosenSource) throw new Error('Choose a display to record.');
    sessionStart = clockUs();
    return { sessionId: recorder.start(), sessionStart };
  });
  handle('capture:frame', frame => recorder.addFrame(frame));
  handle('capture:stop', stop);
  handle('capture:export', async sessionId => {
    if (sessionId !== recorder.sessionId || !sessionId) throw new Error('Start a capture first.');
    if (exporting) throw new Error('An export is in progress.');
    exporting = true;
    try {
      const clip = recorder.manual(clockUs() - sessionStart);
      const destination = await dialog.showOpenDialog(window, {
        title: 'Choose a folder for the clip bundle', properties: ['openDirectory', 'createDirectory']
      });
      if (destination.canceled) return null;
      if (sessionId !== recorder.sessionId || clip.manifest.capture_epoch !== recorder.epoch) {
        throw new Error('The capture changed before export. Record a new clip.');
      }
      return writeBundle(clip, destination.filePaths[0]);
    } finally {
      exporting = false;
    }
  });

  function interrupt(message) {
    if (!recorder.sessionId) return;
    stop(recorder.sessionId);
    window?.webContents.send('capture:interrupted', message);
  }
  powerMonitor.on('suspend', () => interrupt('Capture stopped when the computer went to sleep.'));
  screen.on('display-removed', () => interrupt('The display setup changed. Start a new capture.'));
  screen.on('display-metrics-changed', (_event, _display, metrics) => {
    if (metrics.some(metric => ['bounds', 'scaleFactor', 'rotation'].includes(metric))) {
      interrupt('The display setup changed. Start a new capture.');
    }
  });
  window.on('closed', () => {
    stop(recorder.sessionId);
    window = null;
  });
  await window.loadFile(path.join(__dirname, 'index.html'));
}).catch(error => {
  dialog.showErrorBox('Ojos Capture', error.message);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
