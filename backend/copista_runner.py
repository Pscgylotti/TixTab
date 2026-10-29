"""One offline Copista page per owned subprocess; all intermediates stay in the job directory."""
import json
import os
import sys
from pathlib import Path

os.environ.update(OMP_NUM_THREADS='2', MKL_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2',
                  COPISTERIA_DETECTOR='28m', CUDA_VISIBLE_DEVICES='')


def recognize(directory, source, detector, evidence):
    # Only main-process-owned paths from the checksum-verified model catalogue.
    sys.path.insert(0, str(source / 'src'))
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import torch
    import cv2
    from PIL import Image
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    cv2.setNumThreads(2)
    from copisteria import paths
    paths.DETECTORS['28m'] = (detector, 'v7')
    paths.EVIDENCE = evidence
    from copisteria import pipeline, read, write
    from copisteria.revise import read_revised
    from copista_layout import mapped_writer
    image_path = directory / 'input.png'
    with torch.inference_mode():
        model = read.load_model(evidence, 'cpu')
        detections, candidates, features = pipeline.inputs(image_path, model)
        with Image.open(image_path) as original:
            if original.width * original.height > 4000000:
                raise ValueError('image-size')
            image = original.convert('L')
        try:
            reading = read_revised(detections, image.width, image.height, model,
                device='cpu', attention=False, image=image, cands=candidates, feats=features)
            if not reading.layout.systems:
                raise ValueError('no-score')
            with mapped_writer(reading, write) as layout:
                musicxml = write.write(reading, image=image)
            if not layout['noteLocations']:
                raise ValueError('no-score')
            (directory / 'input.musicxml').write_text(musicxml, encoding='utf-8')
            return dict(ok=True, data=layout)
        finally:
            image.close()


if __name__ == '__main__':
    directory, source, detector, evidence = [Path(p).resolve() for p in sys.argv[1:5]]
    try:
        result = recognize(directory, source, detector, evidence)
    except Exception as error:
        import traceback
        traceback.print_exc()
        allowed = {'no-score', 'score-format', 'score-limit', 'image-size'}
        result = dict(ok=False, error=str(error) if str(error) in allowed else 'recognition-failed')
    (directory / 'result.json').write_text(json.dumps(result, allow_nan=False), encoding='utf-8')
