"""Offline, CPU-bounded homr adapter; temporary images/results belong to IPC."""
import os
import sys
import json
from pathlib import Path
from concurrent.futures import Future

os.environ.update(OMP_NUM_THREADS='2', MKL_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2')
import cv2
import onnxruntime as ort

cv2.setNumThreads(2)
original_session = ort.InferenceSession


def bounded_session(*args, **kwargs):
    options = (args[1] if len(args) > 1 else kwargs.get('sess_options')) or ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.enable_cpu_mem_arena = False
    if len(args) > 1:
        args = (args[0], options, *args[2:])
    else:
        kwargs['sess_options'] = options
    return original_session(*args, **kwargs)


ort.InferenceSession = bounded_session
from homr import main

crop = {'x': 0., 'y': 0., 'width': 1., 'height': 1.}
original_crop = main.autocrop

def record_crop(image):
    cropped = original_crop(image)
    if np.shares_memory(cropped, image):
        offset = cropped.ctypes.data - image.ctypes.data
        y, remainder = divmod(offset, image.strides[0])
        x = remainder // image.strides[1]
        crop.update(x=x/image.shape[1], y=y/image.shape[0], width=cropped.shape[1]/image.shape[1], height=cropped.shape[0]/image.shape[0])
    return cropped


import numpy as np
from homr import staff_parsing, music_xml_generator
# -I omits the script directory; only add our trusted bundled adapter directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from homr_layout import install_layout_hooks
layout = install_layout_hooks(staff_parsing, music_xml_generator, crop)
main.autocrop = record_crop


def no_title(*args, **kwargs):
    future = Future()
    future.set_result('')
    return future


main.detect_title = no_title
main.download_ocr_weights = lambda: None
# Model preparation is checksum-verified by TixTab. Recognition is offline.
def offline_weights(*args, **kwargs):
    from pathlib import Path
    from homr.transformer.configs import default_config
    paths = [main.segnet_path_onnx, default_config.filepaths.encoder_path, default_config.filepaths.decoder_path]
    if any(not Path(p).is_file() for p in paths):
        raise RuntimeError('missing-model')


main.download_weights = offline_weights
sys.argv = ['homr', sys.argv[1], '--gpu', 'no']
main.main()
Path(sys.argv[1]).with_suffix('.staffs.json').write_text(json.dumps(layout, allow_nan=False), encoding='utf-8')
