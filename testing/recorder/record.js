import { recordCalibration } from './calibration.js';

const startButton = document.querySelector('#start');
const stopButton = document.querySelector('#stop');
const calibrationButton = document.querySelector('#calibrate');
const calibrationHelp = document.querySelector('#calibration-help');
const toneButton = document.querySelector('#tone');
const folderName = document.querySelector('#folder-name');
const startHelp = document.querySelector('#start-help');
const stopHelp = document.querySelector('#stop-help');
const preview = document.querySelector('#preview');
const status = document.querySelector('#status');

let saveFolderReady = false;
let webcam;
let session;
let phase = 'idle';

function showStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}

function updateControls() {
  const idle = phase === 'idle';
  const active = phase === 'recording' || phase === 'stopping';
  startButton.hidden = startHelp.hidden = active;
  startButton.disabled = !idle || !saveFolderReady || !navigator.mediaDevices?.getDisplayMedia;
  stopButton.hidden = stopHelp.hidden = !active;
  stopButton.disabled = phase !== 'recording';
  calibrationButton.hidden = calibrationHelp.hidden = phase !== 'recording';
  calibrationButton.disabled = !session?.recordingReady || Boolean(session.calibrationTask);
  toneButton.hidden = phase !== 'recording';
}

function setPhase(value) {
  phase = value;
  updateControls();
}

function releaseCamera() {
  webcam?.getTracks().forEach((track) => track.stop());
  webcam = undefined;
  preview.srcObject = null;
  preview.hidden = true;
}

async function recordingRequest(path = '', options) {
  const response = await fetch('/api/recordings' + path, options);
  if (!response.ok) {
    throw new Error(await response.text() || 'The local recorder could not save this data.');
  }
  return response;
}

function saveManifest({ destination, manifest }) {
  return recordingRequest(`/${destination.id}/capture.json`, {
    method: 'POST',
    body: JSON.stringify(manifest, null, 2),
  });
}

async function loadSaveFolder() {
  try {
    const response = await recordingRequest();
    const { path } = await response.json();
    folderName.textContent = path;
    saveFolderReady = true;
    if (!navigator.mediaDevices?.getDisplayMedia || !navigator.mediaDevices?.getUserMedia) {
      showStatus('Open this address in the Chrome or Edge desktop browser to record.', true);
    } else {
      showStatus('Ready. Choose a screen to start.');
    }
  } catch {
    folderName.textContent = 'Unavailable';
    showStatus('The local recorder is offline. Restart it and refresh this page.', true);
  }
  updateControls();
}

function timestamp(monotonic = performance.now()) {
  return { utc: new Date(performance.timeOrigin + monotonic).toISOString(), performance_ms: monotonic };
}

function createRecorder(stream, destination, name, hasAudio) {
  const mimeType = hasAudio ? 'video/webm;codecs=vp8,opus' : 'video/webm;codecs=vp8';
  const options = { videoBitsPerSecond: hasAudio ? 5_000_000 : 2_000_000 };
  if (MediaRecorder.isTypeSupported(mimeType)) options.mimeType = mimeType;
  const recorder = new MediaRecorder(stream, options);
  const details = { name, mime_type: recorder.mimeType, bytes_saved: 0 };
  let queue = Promise.resolve();
  let failure;
  let startSucceeded = false;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  function handleError(error) {
    failure ??= error ?? new Error('The media encoder stopped.');
    details.error = failure.message;
    resolveReady(false);
    void finishSession('encoder_or_write_error');
  }

  const stopped = new Promise((resolve) => {
    recorder.addEventListener('stop', () => {
      resolveReady(false);
      resolve();
    }, { once: true });
  });
  recorder.addEventListener('start', () => {
    details.started = timestamp();
    details.mime_type = recorder.mimeType;
    resolveReady(true);
  }, { once: true });
  recorder.addEventListener('dataavailable', ({ data }) => {
    if (!data.size) return;
    queue = queue.then(async () => {
      if (failure) return;
      try {
        await recordingRequest(`/${destination.id}/${name}`, { method: 'POST', body: data });
        details.bytes_saved += data.size;
      } catch (error) {
        handleError(error);
      }
    });
  });
  recorder.addEventListener('error', ({ error }) => handleError(error));

  return {
    details,
    ready,
    start() {
      details.start_requested = timestamp();
      recorder.start(1000);
      startSucceeded = true;
    },
    requestStop() {
      if (recorder.state !== 'inactive') recorder.stop();
    },
    async close() {
      if (startSucceeded) await stopped;
      await queue;
      if (failure) throw failure;
    },
  };
}

startButton.addEventListener('click', async () => {
  setPhase('busy');
  showStatus('Choose the display to record.');
  let screen;
  let action = 'screen';
  const recorders = [];
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'monitor', frameRate: { ideal: 20, max: 30 } },
      audio: true,
      systemAudio: 'include',
    });
    const screenVideo = screen.getVideoTracks()[0];
    const screenAudio = screen.getAudioTracks()[0];
    if (screenVideo.getSettings().displaySurface !== 'monitor') {
      throw new Error('Choose a display under Entire Screen.');
    }
    if (!screenAudio || screenAudio.readyState !== 'live') {
      throw new Error('Turn on system audio in the screen share picker and try again.');
    }
    action = 'camera';
    showStatus('Allow webcam access when your browser asks.');
    webcam = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    const cameraVideo = webcam.getVideoTracks()[0];
    preview.srcObject = webcam;
    preview.hidden = false;

    action = 'save';
    showStatus('Preparing the local recording folder…');
    const response = await recordingRequest('', { method: 'POST' });
    const destination = await response.json();
    recorders.push(createRecorder(screen, destination, 'screen-with-audio.webm', true));
    recorders.push(createRecorder(webcam, destination, 'webcam.webm', false));

    if ([cameraVideo, screenVideo, screenAudio].some((track) => track.readyState !== 'live')) {
      throw new Error('A capture device disconnected. Try again.');
    }
    session = {
      screen, destination, recorders,
      manifest: {
        session_id: destination.id,
        time_origin_unix_ms: performance.timeOrigin,
        screen_settings: screenVideo.getSettings(),
        webcam_settings: cameraVideo.getSettings(),
        screen_audio_settings: screenAudio.getSettings(),
        files: recorders.map(({ details }) => details),
        save_complete: false,
      },
    };
    screenVideo.addEventListener('ended', () => { void finishSession('screen_share_ended'); }, { once: true });
    screenAudio.addEventListener('ended', () => { void finishSession('screen_audio_ended'); }, { once: true });
    cameraVideo.addEventListener('ended', () => { void finishSession('webcam_ended'); }, { once: true });
    const activeSession = session;
    activeSession.manifestWrite = saveManifest(activeSession);
    await activeSession.manifestWrite;
    if (session !== activeSession || phase === 'stopping') return;
    for (const recording of recorders) recording.start();
    setPhase('recording');
    showStatus('Starting both recordings…');
    const started = await Promise.all(recorders.map((recording) => recording.ready));
    if (session === activeSession && phase === 'recording' && started.every(Boolean)) {
      activeSession.manifestWrite = saveManifest(activeSession);
      await activeSession.manifestWrite;
      if (session === activeSession && phase === 'recording') {
        activeSession.recordingReady = true;
        updateControls();
        showStatus('Recording webcam, screen, and playback audio.');
      }
    }
  } catch (error) {
    if (session) {
      await finishSession('could_not_start');
    } else {
      screen?.getTracks().forEach((track) => track.stop());
      releaseCamera();
      setPhase('idle');
    }
    if (action === 'screen' && /^(NotAllowedError|InvalidStateError)$/.test(error.name)) {
      showStatus('Screen sharing didn’t start. Try again from the Chrome or Edge desktop browser and click Share in the picker.', true);
    } else if (action === 'camera') {
      showStatus(`Recording couldn’t start because the webcam didn’t open. ${error.message}`, true);
    } else {
      showStatus(`Recording couldn’t start. ${error.message}`, true);
    }
  }
});

async function finishSession(reason) {
  if (!session || phase === 'stopping') return;
  const activeSession = session;
  const { screen, destination, recorders, manifest } = activeSession;
  setPhase('stopping');
  showStatus('Saving recording…');
  activeSession.calibrationController?.abort();
  manifest.stop_requested = timestamp();
  manifest.stop_reason = reason;

  for (const recording of recorders) recording.requestStop();
  screen.getTracks().forEach((track) => track.stop());
  releaseCamera();

  let saveError = false;
  try {
    const outcomes = await Promise.allSettled(recorders.map((recording) => recording.close()));
    saveError = outcomes.some(({ status }) => status === 'rejected')
      || manifest.files.some(({ bytes_saved }) => !bytes_saved);
    manifest.save_complete = !saveError;
    await activeSession.calibrationTask?.catch(() => {});
    await activeSession.manifestWrite?.catch(() => {});
    await saveManifest(activeSession);
    const location = destination.path;
    folderName.textContent = location;
    if (saveError) showStatus(`Some capture data could not be saved. Check ${location}.`, true);
    else if (reason === 'screen_audio_ended') showStatus(`Screen audio disconnected. Saved the recording in ${location}.`, true);
    else showStatus(`Saved in ${location}.`);
  } catch (error) {
    showStatus(`Could not finish saving. ${error.message}`, true);
  } finally {
    session = undefined;
    setPhase('idle');
  }
}

calibrationButton.addEventListener('click', async () => {
  const activeSession = session;
  if (!activeSession?.recordingReady || activeSession.calibrationTask) return;
  const { manifest } = activeSession;
  const controller = new AbortController();
  activeSession.calibrationController = controller;
  activeSession.calibrationTask = recordCalibration(manifest.screen_settings, timestamp, controller)
    .then(async (result) => {
      (manifest.gaze_calibration_attempts ??= []).push(result);
      activeSession.manifestWrite = saveManifest(activeSession);
      await activeSession.manifestWrite;
      return result;
    });
  updateControls();
  try {
    const result = await activeSession.calibrationTask;
    if (session !== activeSession || phase !== 'recording') return;
    if (result.status === 'complete') {
      showStatus('Gaze targets saved. Open the reasoning test when you’re ready.');
    } else if (result.status === 'canceled') {
      showStatus('Calibration canceled. Recording continues. You can try again.');
    } else {
      showStatus(`Calibration couldn’t start or finish. ${result.error}`, true);
    }
  } catch (error) {
    if (session === activeSession && phase === 'recording') {
      showStatus(`Could not save the calibration targets. ${error.message}`, true);
    }
  } finally {
    activeSession.calibrationController = undefined;
    activeSession.calibrationTask = undefined;
    updateControls();
  }
});

stopButton.addEventListener('click', () => { void finishSession('user_stopped'); });

toneButton.addEventListener('click', async () => {
  const audio = new AudioContext();
  try {
    await audio.resume();
    const tone = audio.createOscillator();
    const level = audio.createGain();
    const start = audio.currentTime;
    level.gain.setValueAtTime(0, start);
    level.gain.linearRampToValueAtTime(0.16, start + 0.03);
    level.gain.linearRampToValueAtTime(0, start + 0.6);
    tone.connect(level).connect(audio.destination);
    tone.addEventListener('ended', () => { void audio.close(); }, { once: true });
    tone.start();
    tone.stop(start + 0.6);
  } catch (error) {
    await audio.close();
    showStatus(`Could not play the test tone. ${error.message}`, true);
  }
});

window.addEventListener('beforeunload', (event) => {
  if (!session) return;
  event.preventDefault();
  event.returnValue = true;
});

void loadSaveFolder();
