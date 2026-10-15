"""One bounded image per process; no server or persistent model heap.

UVDoc uses the pinned PaddlePaddle inference export. Scan deskew is a separate
line-based operation. A failed model does not silently become a heuristic.
"""
import json
import math
import os
import sys
import time
from pathlib import Path

os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('MKL_NUM_THREADS', '2')
import cv2
import numpy as np


def deskew(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    ratio = min(1.0, 1400 / max(gray.shape))
    small = cv2.resize(gray, None, fx=ratio, fy=ratio) if ratio < 1 else gray
    edges = cv2.Canny(small, 70, 180)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 720, 60,
                            minLineLength=max(40, small.shape[1] // 8), maxLineGap=15)
    angles, weights = [], []
    for x1, y1, x2, y2 in (() if lines is None else lines.reshape(-1, 4)):
        angle = math.degrees(math.atan2(float(y2-y1), float(x2-x1)))
        if abs(angle) <= 15:
            angles.append(angle)
            weights.append(math.hypot(float(x2-x1), float(y2-y1)))
    if not angles:
        return image, 0.0
    order = np.argsort(angles)
    midpoint = sum(weights) / 2
    accumulated, angle = 0.0, 0.0
    for i in order:
        accumulated += weights[i]
        if accumulated >= midpoint:
            angle = angles[i]
            break
    if abs(angle) < .15:
        return image, 0.0
    height, width = image.shape[:2]
    matrix = cv2.getRotationMatrix2D((width/2, height/2), angle, 1)
    return cv2.warpAffine(image, matrix, (width, height),
                          flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT,
                          borderValue=(255, 255, 255)), angle


def perspective(image):
    height, width = image.shape[:2]
    ratio = min(1., 1200/max(height, width))
    small = cv2.resize(image, None, fx=ratio, fy=ratio)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 50, 150)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:10]:
        if cv2.contourArea(contour) < small.shape[0]*small.shape[1]*.35:
            continue
        points = cv2.approxPolyDP(contour, .025*cv2.arcLength(contour, True), True)
        if len(points) != 4 or not cv2.isContourConvex(points):
            continue
        points = points[:, 0].astype(np.float32) / ratio
        center = points.mean(axis=0)
        points = points[np.argsort(np.arctan2(points[:, 1]-center[1], points[:, 0]-center[0]))]
        points = np.roll(points, -int(np.argmin(points.sum(axis=1))), axis=0)
        destination = np.float32([[0, 0], [width-1, 0], [width-1, height-1], [0, height-1]])
        matrix = cv2.getPerspectiveTransform(points, destination)
        return cv2.warpPerspective(image, matrix, (width, height), flags=cv2.INTER_CUBIC,
                                   borderValue=(255, 255, 255)), True
    return image, False


def unwarp(image, model_file, device, cache_directory):
    import openvino as ov
    from openvino import opset13 as op
    core = ov.Core()
    if device not in ['AUTO', 'CPU', 'GPU', 'NPU']:
        raise ValueError('invalid')
    requested = device
    if device == 'AUTO':
        device = 'NPU' if 'NPU' in core.available_devices else 'CPU'
    if device not in core.available_devices:
        raise ValueError('device-unavailable')
    model = core.read_model(str(model_file))
    model.reshape([1, 3, 488, 288])
    # The original ONNX includes full-resolution GridSample. Compile only the
    # fixed 45x31 neural grid on the accelerator; resampling stays on CPU.
    sampling = next(n for n in model.get_ordered_ops() if n.get_type_name() == 'GridSample')
    node = sampling.input_value(1).get_node()
    while node.get_type_name() in ['Identity', 'Transpose']:
        node = node.input_value(0).get_node()
    if node.get_type_name() != 'Interpolate' or list(node.input_value(0).get_shape()) != [1, 2, 45, 31]:
        raise ValueError('model-output')
    grid_model = ov.Model([node.input_value(0)], model.get_parameters(), 'UVDoc-grid')
    height, width = image.shape[:2]
    tensor = np.ascontiguousarray(image.astype(np.float32).transpose(2, 0, 1)[None] / 255)
    cpu = dict(PERFORMANCE_HINT='LATENCY', NUM_STREAMS=1, INFERENCE_NUM_THREADS=2, INFERENCE_PRECISION_HINT='f32')
    original = op.parameter([1, 3, height, width], np.float32)
    resized = op.interpolate(original, np.int64([488, 288]), 'linear', 'sizes',
                             axes=np.int64([2, 3]), coordinate_transformation_mode='align_corners')
    preprocessor = core.compile_model(ov.Model([resized], [original]), 'CPU', cpu)
    prepared = preprocessor([tensor])[0].copy()
    del preprocessor
    config = dict(PERFORMANCE_HINT='LATENCY', NUM_STREAMS=1)
    if device == 'CPU':
        config.update(cpu)
    elif device == 'NPU':
        config.update(COMPILATION_NUM_THREADS=2, INFERENCE_PRECISION_HINT='f16', CACHE_DIR=str(cache_directory))
    started = time.perf_counter()
    fallback = None
    try:
        compiled = core.compile_model(grid_model, device, config)
    except Exception:
        if requested != 'AUTO' or device == 'CPU':
            raise ValueError('device-incompatible')
        device, fallback = 'CPU', 'accelerator-incompatible'
        compiled = core.compile_model(grid_model, 'CPU', cpu)
    compile_ms = (time.perf_counter()-started)*1000
    started = time.perf_counter()
    grid = compiled([prepared])[0].copy()
    inference_ms = (time.perf_counter()-started)*1000
    del compiled, prepared, grid_model, model
    if grid.shape != (1, 2, 45, 31) or not np.isfinite(grid).all():
        raise ValueError('model-output')
    # Match the source model's align_corners and zero padding exactly. These
    # cheap, image-sized operations do not constrain the NPU graph's shape.
    source = op.parameter([1, 3, height, width], np.float32)
    points = op.parameter([1, 2, 45, 31], np.float32)
    expanded = op.interpolate(points, np.int64([height, width]), 'linear', 'sizes',
                              axes=np.int64([2, 3]), coordinate_transformation_mode='align_corners')
    output = op.grid_sample(source, op.transpose(expanded, np.int64([0, 2, 3, 1])),
                            dict(align_corners=True, mode='bilinear', padding_mode='zeros'))
    mapping = core.compile_model(ov.Model([output], [source, points]), 'CPU', cpu)
    started = time.perf_counter()
    result = mapping([tensor, grid])[0].copy()
    warp_ms = (time.perf_counter()-started)*1000
    if not np.isfinite(result).all():
        raise ValueError('model-output')
    return np.clip(result[0].transpose(1, 2, 0)*255, 0, 255).astype(np.uint8), dict(
        device=device, fallback=fallback, compileMs=round(compile_ms, 2),
        inferenceMs=round(inference_ms, 2), mappingMs=round(warp_ms, 2))


def run(directory, model_file, cache_directory):
    request = json.loads((directory/'request.json').read_text('utf-8'))
    image = cv2.imread(str(directory/'input.png'), cv2.IMREAD_COLOR)
    if image is None or image.shape[0]*image.shape[1] > 4_000_000:
        raise ValueError('image-size')
    cv2.setNumThreads(2)
    mode = request.get('mode')
    if mode not in ['scan', 'photo', 'auto']:
        raise ValueError('invalid')
    warped = False
    metrics = dict(device='CPU')
    if mode in ['photo', 'auto']:
        image, warped = perspective(image)
        image, metrics = unwarp(image, model_file, request.get('device', 'AUTO'), cache_directory)
    image, angle = deskew(image)
    if not cv2.imwrite(str(directory/'output.png'), image):
        raise ValueError('image-write')
    return dict(angle=round(angle, 3), perspective=warped, model='UVDoc' if mode!='scan' else 'scan-deskew',
                width=image.shape[1], height=image.shape[0], **metrics)


if __name__ == '__main__':
    directory = Path(sys.argv[1])
    try:
        result = dict(ok=True, data=run(directory, sys.argv[2], sys.argv[3]))
    except Exception as error:
        import traceback
        traceback.print_exc()
        code = str(error)
        result = dict(ok=False, error=code if code in ['image-size', 'invalid', 'model-output', 'image-write', 'device-unavailable', 'device-incompatible'] else 'correction-failed')
    (directory/'result.json').write_text(json.dumps(result), encoding='utf-8')
