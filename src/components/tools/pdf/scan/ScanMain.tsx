import { useState, useEffect, useCallback, useRef } from 'react';
import { useFileStore } from '@/stores/file-store';

interface CapturedPage {
  id: number;
  dataUrl: string;
  blob: Blob;
  width: number;
  height: number;
}

export function ScanMain() {
  const addFile = useFileStore((s) => s.addFile);
  const setFiles = useFileStore((s) => s.setFiles);
  const files = useFileStore((s) => s.files);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [activeCameraId, setActiveCameraId] = useState<string>('');
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [captures, setCaptures] = useState<CapturedPage[]>([]);
  const [enhance, setEnhance] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [nextId, setNextId] = useState(0);

  // Enumerate cameras
  useEffect(() => {
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        const videoDevices = devices.filter((d) => d.kind === 'videoinput');
        setCameras(videoDevices);
      })
      .catch(() => {});
  }, []);

  // Start camera
  const startCamera = useCallback(async (deviceId?: string) => {
    // Stop any existing stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
    }

    setCameraReady(false);
    setCameraError(null);

    try {
      const constraints: MediaStreamConstraints = {
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          facingMode: 'environment',
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setCameraReady(true);
    } catch (err) {
      const msg =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Camera permission was denied. Please allow camera access in your browser settings.'
          : err instanceof DOMException && err.name === 'NotFoundError'
          ? 'No camera found. Connect a camera or use the Image to PDF tool instead.'
          : err instanceof Error
          ? err.message
          : 'Could not access the camera.';
      setCameraError(msg);
    }
  }, []);

  // Auto-start camera on mount
  useEffect(() => {
    // Wait for device enumeration
    const timer = setTimeout(() => startCamera(), 200);
    return () => {
      clearTimeout(timer);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [startCamera]);

  // Switch camera
  const switchCamera = useCallback(
    (deviceId: string) => {
      setActiveCameraId(deviceId);
      startCamera(deviceId);
    },
    [startCamera],
  );

  // Apply document enhancement to a captured image
  const enhanceImage = useCallback(
    (sourceCanvas: HTMLCanvasElement, width: number, height: number): string => {
      const ctx = sourceCanvas.getContext('2d');
      if (!ctx) return sourceCanvas.toDataURL('image/jpeg', 0.85);

      const imageData = ctx.getImageData(0, 0, width, height);
      const data = imageData.data;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        // Grayscale
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;

        // Contrast stretch: push shadows darker, highlights lighter
        const contrast = (gray - 128) * 1.4 + 128;
        const clamped = Math.max(0, Math.min(255, contrast));

        data[i] = clamped;
        data[i + 1] = clamped;
        data[i + 2] = clamped;
        // alpha stays unchanged
      }

      ctx.putImageData(imageData, 0, 0);
      return sourceCanvas.toDataURL('image/jpeg', 0.85);
    },
    [],
  );

  // Capture photo from video stream
  const capturePhoto = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !cameraReady) return;

    setCapturing(true);

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    canvas.width = vw;
    canvas.height = vh;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setCapturing(false);
      return;
    }

    // Draw current video frame
    ctx.drawImage(video, 0, 0, vw, vh);

    // Apply enhancement or use raw image
    const dataUrl = enhance ? enhanceImage(canvas, vw, vh) : canvas.toDataURL('image/jpeg', 0.85);

    // Convert to blob for PDF generation
    canvas.toBlob((blob) => {
      if (!blob) {
        setCapturing(false);
        return;
      }

      const id = nextId;
      setNextId((n) => n + 1);

      const capture: CapturedPage = {
        id,
        dataUrl,
        blob,
        width: vw,
        height: vh,
      };

      setCaptures((prev) => [...prev, capture]);

      // Also create a File and add to the file store for processing.
      // Read store directly to avoid stale closure values.
      const file = new File([blob], `scan-page-${id + 1}.jpg`, { type: 'image/jpeg' });
      const storeFiles = useFileStore.getState().files;
      if (storeFiles.length === 0) {
        setFiles([file]);
      } else {
        addFile(file);
      }

      setCapturing(false);
    }, 'image/jpeg');
  }, [cameraReady, enhance, enhanceImage, nextId, captures.length, files.length, setFiles, addFile]);

  // Remove a captured page
  const removeCapture = useCallback(
    (id: number) => {
      setCaptures((prev) => {
        const idx = prev.findIndex((c) => c.id === id);
        if (idx === -1) return prev;

        // Also remove from file store
        const store = useFileStore.getState();
        store.removeFile(idx);

        return prev.filter((c) => c.id !== id);
      });
    },
    [],
  );

  // Camera error state
  if (cameraError) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center max-w-sm p-6">
          <div className="mb-4 text-4xl">📷</div>
          <p className="text-xs font-semibold text-danger mb-2">Camera Unavailable</p>
          <p className="text-[11px] text-ink-muted leading-relaxed">{cameraError}</p>
          <button
            onClick={() => startCamera(activeCameraId)}
            className="doodle-btn-secondary mt-4 text-[11px]"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-cream-dark">
      {/* Hidden canvas for frame capture */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Camera preview area */}
      <div className="flex-1 relative flex items-center justify-center bg-black/90 min-h-0">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`max-w-full max-h-full object-contain ${cameraReady ? 'opacity-100' : 'opacity-0'}`}
          style={{ transform: 'scaleX(-1)' }}
        />

        {!cameraReady && !cameraError && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <div className="mb-3 animate-spin text-3xl">📸</div>
              <p className="text-xs text-cream-border/60">Starting camera…</p>
            </div>
          </div>
        )}

        {/* Camera switch button (multiple cameras) */}
        {cameras.length > 1 && cameraReady && (
          <div className="absolute top-3 right-3 flex gap-1.5">
            {cameras.map((cam) => (
              <button
                key={cam.deviceId}
                onClick={() => switchCamera(cam.deviceId)}
                className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
                  cam.deviceId === activeCameraId || (!activeCameraId && cam === cameras[0])
                    ? 'bg-accent text-white'
                    : 'bg-white/10 text-white/70 hover:bg-white/20'
                }`}
              >
                {cam.label.includes('front') || cam.label.includes('user')
                  ? 'Front'
                  : cam.label.includes('back') || cam.label.includes('environment')
                  ? 'Rear'
                  : `Cam ${cameras.indexOf(cam) + 1}`}
              </button>
            ))}
          </div>
        )}

        {/* Enhancement toggle */}
        {cameraReady && (
          <div className="absolute top-3 left-3">
            <button
              onClick={() => setEnhance(!enhance)}
              className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
                enhance
                  ? 'bg-accent text-white'
                  : 'bg-white/10 text-white/70 hover:bg-white/20'
              }`}
            >
              {enhance ? 'Scan' : 'Photo'}
            </button>
          </div>
        )}

        {/* Capture button */}
        {cameraReady && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3">
            <button
              onClick={capturePhoto}
              disabled={capturing}
              className={`
                w-16 h-16 rounded-full border-4 border-white/90
                bg-white/20 hover:bg-white/30
                transition-all duration-200
                active:scale-90 active:bg-white/50
                disabled:opacity-50 disabled:cursor-not-allowed
                shadow-[0_0_20px_rgba(255,255,255,0.2)]
              `}
              aria-label="Capture photo"
            />
            <span className="text-[10px] text-white/60 font-medium">
              {capturing ? 'Capturing…' : 'Tap to scan page'}
            </span>
          </div>
        )}
      </div>

      {/* Captured pages strip */}
      {captures.length > 0 && (
        <div className="shrink-0 border-t border-cream-border bg-cream-light px-4 py-3">
          <div className="flex items-center gap-3 overflow-x-auto scrollbar-hide">
            <span className="text-[10px] font-semibold text-ink-muted shrink-0">
              {captures.length} page{captures.length !== 1 ? 's' : ''}
            </span>
            {captures.map((cap, idx) => (
              <div key={cap.id} className="relative shrink-0 group">
                <img
                  src={cap.dataUrl}
                  alt={`Scanned page ${idx + 1}`}
                  className="h-20 w-auto rounded border border-cream-border object-cover shadow-sm"
                />
                <span className="absolute bottom-0.5 left-0.5 text-[8px] font-mono bg-cream/80 px-1 rounded text-ink-muted">
                  {idx + 1}
                </span>
                <button
                  onClick={() => removeCapture(cap.id)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-danger text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                  aria-label={`Remove page ${idx + 1}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
