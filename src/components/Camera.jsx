import { useRef, useEffect, useState, useCallback } from 'react';
import BrandBar from './BrandBar.jsx';

/**
 * Capture screen. Unchanged from the previous build apart from the status
 * strip below.
 *
 * The marker size is shown persistently and prominently because it is the one
 * setting that silently ruins a whole shift: the pipeline derives px_per_cm by
 * assuming the detected marker is the size that was selected, so a 12cm
 * printout measured as 20cm scales every value by 1.67 with no error raised
 * anywhere. Making the selection impossible to forget is the only defence
 * available without a second reference object in frame.
 *
 * The subject token is shown for the same reason a name used to be: so the
 * operator can see that the photo they are about to take will be attached to
 * the athlete who just tapped. It is opaque, so showing it costs nothing.
 */
export default function Camera({ onCapture, onBack, disabled, markerCm, subjectToken, testMode }) {
  const videoRef    = useRef(null);
  const fileRef     = useRef(null);
  const [mode, setMode]           = useState('camera');
  const [streamReady, setStreamReady] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [countdown, setCountdown]   = useState(null);
  const [useCountdown, setUseCountdown] = useState(false);
  const [preview, setPreview]       = useState(null); // { url, blob }

  useEffect(() => {
    if (mode !== 'camera') return;
    let stream;
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    })
    .then((s) => {
      stream = s;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = s;
      video.onloadedmetadata = () => setStreamReady(true);
    })
    .catch((err) => setCameraError(err.message));

    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [mode]);

  const shoot = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob((blob) => onCapture(blob), 'image/jpeg', 0.92);
  }, [onCapture]);

  const handleCapture = useCallback(() => {
    if (!useCountdown) {
      shoot();
      return;
    }
    let count = 5;
    setCountdown(count);
    const interval = setInterval(() => {
      count -= 1;
      if (count > 0) {
        setCountdown(count);
      } else {
        clearInterval(interval);
        setCountdown(null);
        shoot();
      }
    }, 1000);
  }, [useCountdown, shoot]);

  const handleFileChange = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview({ url, blob: file });
  }, []);

  const handleUsePhoto = useCallback(() => {
    if (!preview) return;
    onCapture(preview.blob);
  }, [preview, onCapture]);

  const handleModeSwitch = useCallback((next) => {
    setMode(next);
    setPreview(null);
    setCountdown(null);
    setCameraError(null);
    setStreamReady(false);
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  const isCounting = countdown !== null;

  return (
    <div className="camera-screen">
      <BrandBar />

      <div className="capture-status-strip">
        <span className="tap-marker-badge">{markerCm} cm marker</span>
        {testMode
          ? <span className="hint-chip">Test mode — nothing will be saved</span>
          : subjectToken && <span className="subject-token small">{subjectToken}</span>}
      </div>

      <div className="camera-mode-toggle">
        <button
          className={`camera-mode-btn${mode === 'camera' ? ' active' : ''}`}
          onClick={() => handleModeSwitch('camera')}
          disabled={disabled}
        >
          Camera
        </button>
        <button
          className={`camera-mode-btn${mode === 'library' ? ' active' : ''}`}
          onClick={() => handleModeSwitch('library')}
          disabled={disabled}
        >
          Photo Library
        </button>
      </div>

      {mode === 'camera' ? (
        cameraError ? (
          <div style={{ padding: 24, flex: 1 }}>
            <button className="camera-back-btn" style={{ position: 'static', marginBottom: 16 }} onClick={onBack} aria-label="Back">×</button>
            <div className="error-card">Camera error: {cameraError}</div>
          </div>
        ) : (
          <div className="camera-wrapper">
            <video ref={videoRef} className="camera-video" autoPlay playsInline muted />

            <button className="camera-back-btn" onClick={onBack} disabled={disabled} aria-label="Back">×</button>

            {isCounting && (
              <div className="countdown-overlay">
                <span className="countdown-number">{countdown}</span>
              </div>
            )}

            <div className="capture-bar">
              <button
                className="timer-toggle"
                onClick={() => setUseCountdown((v) => !v)}
                disabled={disabled || isCounting}
              >
                {useCountdown ? '5s' : 'instant'}
              </button>

              <button
                className="capture-btn"
                onClick={handleCapture}
                disabled={disabled || !streamReady || isCounting}
              >
                {disabled ? '…' : 'CAP'}
              </button>

              <div style={{ width: 52 }} />
            </div>

            {disabled && (
              <div className="processing-overlay">
                <div className="spinner" />
                <p>Measuring…</p>
              </div>
            )}
          </div>
        )
      ) : (
        <div className="library-wrapper">
          <button className="camera-back-btn" style={{ position: 'absolute', top: 16, left: 16, zIndex: 2 }} onClick={onBack} disabled={disabled} aria-label="Back">×</button>

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />

          {preview ? (
            <div className="library-preview-area">
              <img
                src={preview.url}
                alt="Selected photo"
                className="library-preview-img"
              />
              <div className="library-preview-actions">
                <button
                  className="library-change-btn"
                  onClick={() => fileRef.current?.click()}
                  disabled={disabled}
                >
                  Change
                </button>
                <button
                  className="capture-btn library-use-btn"
                  onClick={handleUsePhoto}
                  disabled={disabled}
                >
                  {disabled ? '…' : 'USE'}
                </button>
              </div>
            </div>
          ) : (
            <div className="library-pick-area">
              <div className="library-pick-card" onClick={() => fileRef.current?.click()}>
                <div className="library-pick-icon">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                  </svg>
                </div>
                <p className="library-pick-label">Choose Photo</p>
                <p className="library-pick-sub">Tap to open your photo library</p>
              </div>
            </div>
          )}

          {disabled && (
            <div className="processing-overlay" style={{ position: 'fixed' }}>
              <div className="spinner" />
              <p>Measuring…</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
