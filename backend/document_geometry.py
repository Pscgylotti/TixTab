"""Bounded, non-generative document geometry and appearance correction."""
import math
import cv2
import numpy as np

MAX_PIXELS = 4_000_000


def output_size(width, height):
    scale = min(1., math.sqrt(MAX_PIXELS / max(1, width * height)), 8192 / max(width, height))
    return max(2, round(width * scale)), max(2, round(height * scale))


def ordered_quad(points):
    points = np.asarray(points, np.float32)
    if points.shape != (4, 2) or not np.isfinite(points).all():
        raise ValueError('invalid-geometry')
    # Preserve the user's TL/TR/BR/BL correspondence, including deliberate rotation.
    edges = np.roll(points, -1, axis=0)-points
    cross = [edges[i,0]*edges[(i+1)%4,1]-edges[i,1]*edges[(i+1)%4,0] for i in range(4)]
    if min(cross) <= 1e-5 or abs(cv2.contourArea(points)) < .01:
        raise ValueError('invalid-geometry')
    return points


def detect_corners(image):
    h, w = image.shape[:2]
    ratio = min(1., 1200/max(h, w))
    small = cv2.resize(image, None, fx=ratio, fy=ratio)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    edge = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 40, 120)
    edge = cv2.morphologyEx(edge, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    contours, _ = cv2.findContours(edge, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:30]:
        if cv2.contourArea(c) < small.shape[0] * small.shape[1] * .12:
            continue
        points = cv2.approxPolyDP(c, .02 * cv2.arcLength(c, True), True)
        if len(points) != 4 or not cv2.isContourConvex(points):
            continue
        p = points[:, 0].astype(np.float32) / ratio / [w-1, h-1]
        center = p.mean(axis=0)
        p = p[np.argsort(np.arctan2(p[:, 1]-center[1], p[:, 0]-center[0]))]
        p = np.roll(p, -int(np.argmin(p.sum(axis=1))), axis=0)
        try:
            return ordered_quad(np.clip(p, 0, 1)).tolist()
        except ValueError:
            continue
    return None


def rectify(image, corners, aspect='auto'):
    h, w = image.shape[:2]
    points = ordered_quad(corners) * [w-1, h-1]
    width = max(np.linalg.norm(points[1]-points[0]), np.linalg.norm(points[2]-points[3]))
    height = max(np.linalg.norm(points[3]-points[0]), np.linalg.norm(points[2]-points[1]))
    ratios = {'id-landscape': 85.6/53.98, 'id-portrait': 53.98/85.6,
              'a4': 210/297, 'letter': 8.5/11, 'square': 1.}
    if aspect != 'auto':
        ratio = ratios[aspect]
        area = width * height
        width, height = math.sqrt(area * ratio), math.sqrt(area / ratio)
    width, height = output_size(width, height)
    target = np.float32([[0, 0], [width-1, 0], [width-1, height-1], [0, height-1]])
    transform = cv2.getPerspectiveTransform(points.astype(np.float32), target)
    return cv2.warpPerspective(image, transform, (width, height), flags=cv2.INTER_CUBIC,
                               borderValue=(255, 255, 255))


def rotate(image, angle):
    if abs(angle) < .001:
        return image
    h, w = image.shape[:2]
    radians = math.radians(angle)
    nw, nh = output_size(abs(w*math.cos(radians))+abs(h*math.sin(radians)),
                         abs(h*math.cos(radians))+abs(w*math.sin(radians)))
    scale = min(nw / (abs(w*math.cos(radians))+abs(h*math.sin(radians))),
                nh / (abs(h*math.cos(radians))+abs(w*math.sin(radians))))
    m = cv2.getRotationMatrix2D((w/2, h/2), angle, scale)
    m[:, 2] += [(nw-w)/2, (nh-h)/2]
    return cv2.warpAffine(image, m, (nw, nh), flags=cv2.INTER_CUBIC, borderValue=(255, 255, 255))


def projection_angle(image):
    """Projection-profile deskew handles text scans without long Hough lines."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    scale = min(1., 900/max(gray.shape))
    gray = cv2.resize(gray, None, fx=scale, fy=scale)
    _, mask = cv2.threshold(gray, 0, 1, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    h, w = mask.shape
    if mask.mean() < .003 or mask.mean() > .55:
        return 0.
    def score(angle):
        m = cv2.getRotationMatrix2D((w/2, h/2), float(angle), 1)
        rows = cv2.warpAffine(mask, m, (w, h), flags=cv2.INTER_NEAREST).sum(axis=1).astype(float)
        return np.square(np.diff(rows)).sum()
    angles = np.arange(-15, 15.01, .5)
    best = angles[np.argmax([score(a) for a in angles])]
    fine = np.arange(best-.5, best+.51, .1)
    selected = float(fine[np.argmax([score(a) for a in fine])])
    return selected if score(selected) > score(0)*1.04 else 0.


def flatten_book(image, strength=1.):
    """Fit shared text-line curvature; abstain on weak/non-text evidence."""
    h, w = image.shape[:2]
    scale = min(1., 1200/max(h, w))
    small = cv2.resize(image, None, fx=scale, fy=scale)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY_INV, 31, 15)
    connected = cv2.dilate(binary, np.ones((3, max(9, small.shape[1]//40)), np.uint8))
    contours, _ = cv2.findContours(connected, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    curves = []
    for contour in contours:
        x, y, cw, ch = cv2.boundingRect(contour)
        if cw < small.shape[1]*.45 or ch > small.shape[0]*.12 or ch < 3:
            continue
        xs, ys = [], []
        for xx in range(x, x+cw, max(2, cw//40)):
            rows = np.flatnonzero(binary[y:y+ch, xx])
            if len(rows):
                xs.append(xx/max(1, small.shape[1]-1))
                ys.append((y+np.median(rows))/scale)
        if len(xs) < 12:
            continue
        co = np.polyfit(xs, ys, 2)
        residual = np.median(np.abs(np.polyval(co, xs)-ys))
        if residual < max(3, ch/scale*.18) and abs(co[0]) < h*.5:
            curves.append(co[0])
    if len(curves) < 3:
        return image, False
    curvature = float(np.median(curves))
    if np.median(np.abs(np.array(curves)-curvature)) > max(4, abs(curvature)*.6):
        return image, False
    x = np.linspace(0, 1, w, dtype=np.float32)
    offset = curvature*(x*x-x)*strength
    if np.max(np.abs(offset)) < .75:
        return image, False
    map_x = np.broadcast_to(np.arange(w, dtype=np.float32), (h, w))
    map_y = np.arange(h, dtype=np.float32)[:, None]+offset
    return cv2.remap(image, map_x, map_y, cv2.INTER_CUBIC,
                     borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255)), True


def mesh_warp(image, mesh):
    """A 5x5 output-to-source grid; validate every cell to reject foldovers."""
    grid = np.asarray(mesh, np.float32)
    if grid.shape != (25, 2) or not np.isfinite(grid).all() or grid.min() < 0 or grid.max() > 1:
        raise ValueError('invalid-geometry')
    grid = grid.reshape(5, 5, 2)
    for y in range(4):
        for x in range(4):
            ordered_quad([grid[y, x], grid[y, x+1], grid[y+1, x+1], grid[y+1, x]])
    h, w = image.shape[:2]
    # remap samples grid coordinates at evenly spaced output positions, endpoints included.
    xs = np.linspace(0, 4, w, dtype=np.float32)
    ys = np.linspace(0, 4, h, dtype=np.float32)
    low = np.minimum(3, ys.astype(int))
    fraction = (ys-low).astype(np.float32)[:, None]
    maps = []
    for dimension, length in [(0,w), (1,h)]:
        rows = np.array([np.interp(xs, np.arange(5), row[:,dimension]) for row in grid], np.float32)
        maps.append((rows[low]*(1-fraction)+rows[low+1]*fraction)*(length-1))
    return cv2.remap(image, maps[0], maps[1], cv2.INTER_CUBIC,
                     borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))


def lighting(image, strength):
    if not strength:
        return image
    small = cv2.resize(image, (min(256, image.shape[1]), min(256, image.shape[0])))
    background = cv2.GaussianBlur(cv2.morphologyEx(small, cv2.MORPH_CLOSE,
                                 np.ones((21, 21), np.uint8)), (31, 31), 0)
    background = cv2.resize(background, (image.shape[1], image.shape[0])).astype(np.float32)
    flattened = np.clip(image.astype(np.float32)*245/np.maximum(background, 30), 0, 255)
    return np.clip(image*(1-strength)+flattened*strength, 0, 255).astype(np.uint8)


def docaligner(image, model_file, device, cache_directory):
    """DocAligner 1.1.1 BGR/255 heatmaps; no runtime downloads or capybara dependency."""
    import openvino as ov
    core = ov.Core()
    requested = device
    device = ('GPU' if 'GPU' in core.available_devices else 'CPU') if device == 'AUTO' else device
    if device not in core.available_devices:
        raise ValueError('device-unavailable')
    config = {'PERFORMANCE_HINT': 'LATENCY', 'NUM_STREAMS': 1}
    if device == 'CPU':
        config.update(INFERENCE_NUM_THREADS=2)
    if device == 'NPU':
        config.update(CACHE_DIR=str(cache_directory), COMPILATION_NUM_THREADS=2)
    graph = core.read_model(str(model_file))
    # Upstream exports a dynamic batch; every local job is exactly one image.
    # Fix it before NPU compilation so intermediate tensor bounds are known.
    graph.reshape({0: [1, 3, 256, 256]})
    fallback = None
    try:
        model = core.compile_model(graph, device, config)
    except Exception:
        if requested != 'AUTO':
            raise ValueError('device-incompatible')
        device, fallback = 'CPU', 'accelerator-incompatible'
        model = core.compile_model(graph, 'CPU', {'INFERENCE_NUM_THREADS': 2})
    tensor = np.ascontiguousarray(cv2.resize(image, (256, 256)).transpose(2, 0, 1)[None], dtype=np.float32)/255
    heatmaps = model([tensor])[0]
    if heatmaps.ndim != 4 or heatmaps.shape[1] != 4 or not np.isfinite(heatmaps).all():
        raise ValueError('model-output')
    points = []
    for heat in heatmaps[0]:
        mask = ((heat >= .3)*255).astype(np.uint8)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            raise ValueError('no-document')
        moments = cv2.moments(max(contours, key=cv2.contourArea))
        if moments['m00'] == 0:
            raise ValueError('no-document')
        points.append([moments['m10']/moments['m00']/(heat.shape[1]-1),
                       moments['m01']/moments['m00']/(heat.shape[0]-1)])
    return ordered_quad(points).tolist(), dict(device=device, fallback=fallback)
