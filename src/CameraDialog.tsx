import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  Camera,
  Copy,
  ImagePlus,
  RotateCcw,
  RotateCw,
  FlipHorizontal,
  FlipVertical,
  Crop,
  SwitchCamera,
  X,
} from 'lucide-react';
import { copyCanvasImage } from './clipboard';
import { t } from './i18n';
import ImageCropDialog from './ImageCropDialog';
import './camera.css';

export default function CameraDialog({
  onInsert,
  onClose,
}: {
  onInsert: (data: string, width: number, height: number) => Promise<void>;
  onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null),
    stream = useRef<MediaStream | null>(null),
    canvas = useRef<HTMLCanvasElement | null>(null),
    lifetime = useRef(new AbortController());
  const [attempt, setAttempt] = useState(0),
    [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [deviceId, setDeviceId] = useState(''),
    [activeDevice, setActiveDevice] = useState(''),
    [portrait, setPortrait] = useState(window.innerHeight > window.innerWidth),
    [dimensions, setDimensions] = useState({ width: 0, height: 0 }),
    [cropping, setCropping] = useState(false),
    [photo, setPhoto] = useState(''),
    [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false);
  const portraitRef = useRef(portrait);
  portraitRef.current = portrait;
  // Capture constraints are preferences: a camera can keep delivering a
  // landscape frame in portrait orientation. Fit its actual output instead.
  const aspect =
    dimensions.width && dimensions.height
      ? dimensions.width / dimensions.height
      : portrait
        ? 9 / 16
        : 16 / 9;
  const resolution = (): MediaTrackConstraints => ({
    width: { ideal: portraitRef.current ? 1080 : 1920 },
    height: { ideal: portraitRef.current ? 1920 : 1080 },
    aspectRatio: { ideal: portraitRef.current ? 9 / 16 : 16 / 9 },
  });
  const refreshDevices = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      if (lifetime.current.signal.aborted) return;
      const cameras = all.filter((device) => device.kind === 'videoinput' && device.deviceId);
      setDevices(cameras);
      if (cameras.length)
        setDeviceId((id) => (cameras.some((device) => device.deviceId === id) ? id : ''));
    } catch {
      /* Some camera drivers do not expose device enumeration. */
    }
  };
  const measureVideo = () => {
    const source = video.current;
    if (!source?.videoWidth || !source.videoHeight) return;
    setDimensions({ width: source.videoWidth, height: source.videoHeight });
    setReady(true);
  };
  const stop = () => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  };
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const rotate = () => setPortrait(window.innerHeight > window.innerWidth);
    window.addEventListener('resize', rotate);
    screen.orientation?.addEventListener('change', rotate);
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => {
      window.removeEventListener('resize', rotate);
      screen.orientation?.removeEventListener('change', rotate);
      navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
    };
  }, []);
  useEffect(() => {
    const track = stream.current?.getVideoTracks()[0];
    if (!photo && track?.readyState === 'live')
      void track.applyConstraints(resolution()).catch(() => {
        // Keep the current stream if the driver cannot supply the ideal size.
      });
  }, [portrait, photo]);
  useEffect(() => {
    if (photo) return;
    let cancelled = false;
    setReady(false);
    setError('');
    setStatus(t('正在打开摄像头…'));
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unavailable');
        const next = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            ...resolution(),
            ...(deviceId
              ? { deviceId: { exact: deviceId } }
              : { facingMode: { ideal: 'environment' } }),
          },
        });
        if (cancelled) {
          next.getTracks().forEach((track) => track.stop());
          return;
        }
        stream.current = next;
        const track = next.getVideoTracks()[0];
        setActiveDevice(track?.getSettings().deviceId ?? deviceId);
        void refreshDevices();
        if (track) {
          // Orientation may have changed while the system permission prompt was open.
          void track.applyConstraints(resolution()).catch(() => {});
          track.addEventListener(
            'ended',
            () => {
              if (!cancelled) {
                setReady(false);
                setError(t('摄像头已断开，请选择其它摄像头或重试。'));
              }
            },
            { once: true },
          );
        }
        if (video.current) {
          video.current.srcObject = next;
          await video.current.play();
        }
        if (!cancelled) setStatus('');
      } catch (reason) {
        if (cancelled) return;
        stop();
        const name = reason instanceof Error ? reason.name : '';
        setError(
          t(
            name === 'NotAllowedError' || name === 'SecurityError'
              ? '摄像头访问被拒绝，请在系统隐私设置中允许摄像头访问后重试。'
              : name === 'NotFoundError'
                ? '未找到摄像头，请连接摄像头后重试。'
                : '无法打开摄像头，请检查摄像头是否被其它应用占用后重试。',
          ),
        );
        setStatus('');
      }
    })();
    return () => {
      cancelled = true;
      stop();
    };
  }, [attempt, photo, deviceId]);
  const showPhoto = (target: HTMLCanvasElement) => {
    canvas.current = target;
    setDimensions({ width: target.width, height: target.height });
    setPhoto(target.toDataURL('image/png'));
    setStatus('');
  };
  const capture = () => {
    const source = video.current;
    if (!source?.videoWidth || !source.videoHeight) return;
    const target = document.createElement('canvas'),
      scale = Math.min(1, Math.sqrt(12_000_000 / (source.videoWidth * source.videoHeight)));
    target.width = Math.max(1, Math.round(source.videoWidth * scale));
    target.height = Math.max(1, Math.round(source.videoHeight * scale));
    const context = target.getContext('2d');
    if (!context) return;
    context.drawImage(source, 0, 0, target.width, target.height);
    showPhoto(target);
    stop();
  };
  const transform = (action: 'rotate' | 'horizontal' | 'vertical') => {
    const source = canvas.current;
    if (!source) return;
    const target = document.createElement('canvas');
    target.width = action === 'rotate' ? source.height : source.width;
    target.height = action === 'rotate' ? source.width : source.height;
    const context = target.getContext('2d');
    if (!context) return;
    context.translate(target.width / 2, target.height / 2);
    if (action === 'rotate') context.rotate(Math.PI / 2);
    else context.scale(action === 'horizontal' ? -1 : 1, action === 'vertical' ? -1 : 1);
    context.drawImage(source, -source.width / 2, -source.height / 2);
    showPhoto(target);
  };
  return createPortal(
    <div
      className="modal-scrim"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <section
        className={`modal camera-dialog${portrait ? ' camera-portrait' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('拍照')}
      >
        <header>
          <h2>
            <Camera size={22} />
            {t('拍照')}
          </h2>
          <button autoFocus aria-label={t('关闭')} onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {!photo && (
          <div className="camera-devices">
            <label>
              {t('摄像头')}
              <select
                aria-label={t('选择摄像头')}
                value={deviceId || activeDevice}
                onChange={(event) => setDeviceId(event.target.value)}
              >
                {!devices.length && <option value="">{t('默认摄像头')}</option>}
                {devices.map((device, i) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || t('摄像头 {0}', i + 1)}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={devices.length < 2}
              title={t('切换摄像头')}
              aria-label={t('切换摄像头')}
              onClick={() => {
                const i = devices.findIndex(
                  (device) => device.deviceId === (deviceId || activeDevice),
                );
                setDeviceId(devices[(i + 1) % devices.length].deviceId);
              }}
            >
              <SwitchCamera size={20} />
            </button>
          </div>
        )}
        <div className="camera-viewfinder" style={{ '--camera-aspect': aspect } as CSSProperties}>
          {photo ? (
            <img src={photo} alt={t('照片预览')} />
          ) : (
            <video
              ref={video}
              muted
              playsInline
              autoPlay
              onLoadedData={measureVideo}
              onResize={measureVideo}
            />
          )}
          {error && (
            <div className="camera-error" role="alert">
              <p>{error}</p>
              <button onClick={() => setAttempt((n) => n + 1)}>{t('重试')}</button>
            </div>
          )}
        </div>
        <div className="camera-photo-tools">
          {photo && (
            <>
              <button
                disabled={busy}
                title={t('顺时针旋转图片')}
                aria-label={t('顺时针旋转图片')}
                onClick={() => transform('rotate')}
              >
                <RotateCw size={20} />
              </button>
              <button
                disabled={busy}
                title={t('水平镜像')}
                aria-label={t('水平镜像')}
                onClick={() => transform('horizontal')}
              >
                <FlipHorizontal size={20} />
              </button>
              <button
                disabled={busy}
                title={t('垂直镜像')}
                aria-label={t('垂直镜像')}
                onClick={() => transform('vertical')}
              >
                <FlipVertical size={20} />
              </button>
              <button
                disabled={busy}
                title={t('裁剪图片')}
                aria-label={t('裁剪图片')}
                onClick={() => setCropping(true)}
              >
                <Crop size={20} />
              </button>
            </>
          )}
          {dimensions.width > 0 && (
            <span className="camera-resolution">
              {dimensions.width} × {dimensions.height}
            </span>
          )}
        </div>
        <p className="camera-status" role="status">
          {status}
        </p>
        <footer>
          {photo ? (
            <>
              <button
                disabled={busy}
                onClick={() => {
                  canvas.current = null;
                  setPhoto('');
                  setStatus('');
                }}
              >
                <RotateCcw size={18} />
                {t('重拍')}
              </button>
              <button
                disabled={busy}
                onClick={async () => {
                  if (!canvas.current) return;
                  setBusy(true);
                  try {
                    await copyCanvasImage(canvas.current, lifetime.current.signal);
                    setStatus(t('图片已复制，可粘贴到聊天或其它应用。'));
                  } catch {
                    if (!lifetime.current.signal.aborted)
                      setStatus(t('图片复制失败，请检查剪贴板权限后重试。'));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Copy size={18} />
                {t('复制图片')}
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={async () => {
                  if (!canvas.current) return;
                  setBusy(true);
                  try {
                    await onInsert(photo, canvas.current.width, canvas.current.height);
                    onClose();
                  } catch {
                    setStatus(t('照片插入失败，请重试。'));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <ImagePlus size={18} />
                {t('插入当前页')}
              </button>
            </>
          ) : (
            <button className="primary" disabled={!ready || !!error} onClick={capture}>
              <Camera size={18} />
              {t('拍照')}
            </button>
          )}
        </footer>
      </section>
      {cropping && canvas.current && (
        <ImageCropDialog
          image={{
            id: 'camera-photo',
            kind: 'image',
            data: photo,
            x: 0,
            y: 0,
            width: canvas.current.width,
            height: canvas.current.height,
          }}
          onClose={() => setCropping(false)}
          onApply={(image) => {
            setCropping(false);
            setBusy(true);
            const source = new Image();
            source.onload = () => {
              if (lifetime.current.signal.aborted) return;
              const target = document.createElement('canvas');
              target.width = source.naturalWidth;
              target.height = source.naturalHeight;
              target.getContext('2d')?.drawImage(source, 0, 0);
              showPhoto(target);
              setBusy(false);
            };
            source.onerror = () => {
              setStatus(t('无法裁剪图片，请重试。'));
              setBusy(false);
            };
            source.src = image.data;
          }}
        />
      )}
    </div>,
    document.body,
  );
}
