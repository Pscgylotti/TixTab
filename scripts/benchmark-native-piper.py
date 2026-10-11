"""Actual app-produced phonemes; cold namespace, warm end-to-end and latent parity.

Not a speech intelligibility or electrical power measurement. Synthesis contains
stochastic duration/noise, so record real duration/RTF for every invocation.
"""
import hashlib
import json
import os
from pathlib import Path
import statistics
import sys
import time
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from backend.native_piper import NativePiper, decoder_context

source=Path(sys.argv[1] if len(sys.argv)>1 else 'test-results/native-tts0211.json')
report_path=Path(sys.argv[2] if len(sys.argv)>2 else 'docs/benchmarks/piper-openvino-20261011.json')
app=json.loads(source.read_text('utf-8-sig'))
cases=[app['inputs'][0],app['inputs'][4]]
report={'appVersion':'0.2.11','date':'2026-10-11','sourceInputs':str(source),
        'nativeSourceSha256':hashlib.sha256(Path('backend/native_piper.py').read_bytes()).hexdigest(),
        'scope':'Backend only; actual app phonemes; does not include phonemization or playback. Stochastic audio duration; not power/intelligibility.',
        'cacheNamespace':os.environ.get('SURFACETAB_PIPER_CACHE'),
        'cacheInitiallyEmpty':not Path(os.environ.get('SURFACETAB_PIPER_CACHE','unused')).exists(),
        'routeOrder':'CPU then NPU then GPU; shared CPU sessions are warm for accelerator first calls', 'cases':[]}
for case in cases:
    start=time.perf_counter();p=NativePiper(case['voice']);load_ms=(time.perf_counter()-start)*1000
    entry={'voice':case['voice'],'phonemeLengths':[len(ids) for ids in case['chunks']],
           'loadMs':load_ms,'validatedContextFrames':decoder_context(p.vocoder),'routes':[]}
    for device in ('CPU','NPU','GPU'):
        runs=[]
        for i in range(6):
            result=p.synthesize(case['chunks'],device)
            duration=result['audioSamples']/result['sampleRate']
            runs.append({'timing':result['timing'],'audioSeconds':duration,
                         'realTimeFactor':result['timing']['totalMs']/1000/duration,
                         'vocoderDevices':result['vocoderDevices'],'failures':result['failures']})
        entry['routes'].append({'requested':device,'runs':runs,'warmMedianMs':statistics.median(r['timing']['totalMs'] for r in runs[1:]),
                               'warmMedianRtf':statistics.median(r['realTimeFactor'] for r in runs[1:])})
    # Same real latent on all decoders: isolate numerical/partition differences
    # from the model's stochastic duration and waveform noise.
    p.cancelled=None;p.deadline=time.monotonic()+120;p.compile_ms=0;p.stage_ms={'upstream':0,'vocoder':0};p.used=set()
    ids=case['chunks'][0];conf=p.config['inference']
    latent=p.infer('upstream','CPU',{'input':np.array([ids],np.int64),'input_lengths':np.array([len(ids)],np.int64),
                    'scales':np.array([conf['noise_scale'],conf['length_scale'],conf['noise_w']],np.float32)})
    reference=p.decode(latent,'CPU');entry['sameLatentParity']=[]
    for device in ('NPU','GPU'):
        actual=p.decode(latent,device);diff=actual-reference
        entry['sameLatentParity'].append({'device':device,'frames':latent.shape[2],'samples':len(actual),
                'maxAbsoluteDifference':float(np.abs(diff).max()),'rmsDifference':float(np.sqrt(np.mean(diff**2))),
                'signalRms':float(np.sqrt(np.mean(reference**2)))})
    report['cases'].append(entry)
    report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf-8')
    print(json.dumps({'voice':entry['voice'],'routes':[(r['requested'],r['warmMedianMs']) for r in entry['routes']],'parity':entry['sameLatentParity']}),flush=True)
    del p
cache=Path(os.environ.get('SURFACETAB_PIPER_CACHE','unused'))
report['cacheObservedBytes']=sum(p.stat().st_size for p in cache.rglob('*') if p.is_file()) if cache.exists() else None
report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf-8')
