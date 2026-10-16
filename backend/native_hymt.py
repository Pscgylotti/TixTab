"""Official Hy-MT2 1.8B Q4_K_M, reusing the existing isolated llama.cpp runtime.

No Python dependencies or environment are added. Weights are opt-in, pinned,
verified downloads. The parent service owns cancellation, idle policy and one
native inference lane; WindowsJob kills the worker if the parent disappears.
"""
from pathlib import Path
import json
import queue
import threading
import time
import os
import re
try:
    from .native_unimumer import NativeUnimumer, verify, runtime
    from .managed_store import managed_directory
except ImportError:
    from native_unimumer import NativeUnimumer, verify, runtime
    from managed_store import managed_directory

MANIFEST = json.loads(Path(__file__).with_name('hymt-manifest.json').read_text('utf-8'))
LANGUAGES = {'zh-CN': 'Simplified Chinese', 'en': 'English', 'ja': 'Japanese', 'ko': 'Korean', 'fr': 'French'}


class NativeHyMt(NativeUnimumer):
    engine_label = 'Hy-MT2'
    supports_npu = False
    def model_files(self):
        base = managed_directory(MANIFEST['id'], MANIFEST['revision'])
        if base is None:
            raise ValueError('Download Hy-MT2 1.8B and shared llama.cpp runtime in Local model manager first')
        files = []
        for item in MANIFEST['files']:
            path = base / item['path']
            verify(path, item)
            files.append(path)
        return files

    def server_arguments(self, requested):
        args = [str(self.executable), '-m', str(self.files[0]), '--host', '127.0.0.1',
                '--port', str(self.port), '--api-key', self.key, '--alias', 'hymt2-1.8b',
                '-c', '8192', '-np', '1', '-t', '2', '-tb', '4', '-ngl',
                '0' if requested == 'CPU' else '99', '-b', '256', '-ub', '128', '--no-webui', '--jinja', '-lv', '4', '--cache-ram', '0']
        if requested == 'GPU': args += ['--device', 'Vulkan0']
        return args

    def translate(self, text, target, device='CPU', cancelled=None):
        cancelled = cancelled or threading.Event()
        if device not in (['AUTO', 'GPU', 'CPU', 'NPU'] if self.supports_npu else ['AUTO', 'GPU', 'CPU']):
            raise ValueError('Hy-MT2 supports Vulkan GPU and CPU only')
        if target not in LANGUAGES or not isinstance(text, str) or not text.strip() or len(text) > 10000:
            raise ValueError('Invalid translation input or target language')
        started = time.perf_counter()
        self.start(device, cancelled)
        if device in ['GPU', 'NPU'] and self.encoder_device != device:
            self.close()
            raise RuntimeError('Requested accelerator did not offload the translation model')
        # Official default task prompt. The embedded GGUF chat template supplies
        # model-specific tokens; no guessed system prompt or token IDs.
        messages = [{'role': 'user', 'content':
                     f'Translate the following text into {LANGUAGES[target]}. Note that you should only output the translated result without any additional explanation:\n{text}'}]
        responses = queue.Queue(maxsize=1)
        context_limit = 2048 if device == 'NPU' else 8192
        def work():
            try:
                prompt = self.request('/apply-template', {'messages': messages})['prompt']
                tokens = self.request('/tokenize', {'content': prompt})['tokens']
                if len(tokens) > context_limit - 512:
                    raise ValueError('Translation input exceeds model context; use a shorter passage')
                result = self.request('/v1/chat/completions', {
                    'model': 'hymt2-1.8b', 'messages': messages, 'temperature': 0.7,
                    'top_p': 0.6, 'top_k': 20, 'min_p': 0.0, 'repeat_penalty': 1.05,
                    'max_tokens': min(4096, context_limit - len(tokens) - 16), 'stream': False,
                    'cache_prompt': False,
                })
                responses.put((True, result))
            except Exception as error:
                responses.put((False, error))
        thread = threading.Thread(target=work, daemon=True)
        thread.start()
        deadline = time.monotonic() + 170
        while True:
            if cancelled.is_set():
                self.close(); thread.join(timeout=2); raise InterruptedError()
            if time.monotonic() > deadline:
                self.close(); thread.join(timeout=2); raise TimeoutError('Hy-MT2 translation timed out')
            try: ok, value = responses.get(timeout=.1); break
            except queue.Empty: pass
        if not ok:
            if isinstance(value, ValueError): raise value
            self.close()
            raise RuntimeError('Hy-MT2 local inference failed') from value
        choice = value.get('choices', [{}])[0]
        translated = choice.get('message', {}).get('content', '')
        if choice.get('finish_reason') not in ['stop', 'end_turn'] or not isinstance(translated, str) or not translated.strip():
            raise ValueError('Incomplete translation; use a shorter passage')
        return {'translation': translated.strip(), 'encoderDevice': self.encoder_device,
                'decoderDevice': self.encoder_device, 'requestedDevice': device,
                'fallback': device == 'AUTO' and self.encoder_device != 'GPU',
                'engine': 'Hy-MT2 1.8B Q4_K_M', 'timing': {'totalMs': (time.perf_counter() - started) * 1000}}


class NativeHyMtOpenVino(NativeHyMt):
    engine_label = 'Hy-MT2 OpenVINO'
    supports_npu = True

    def runtime_executable(self):
        record = json.loads(Path(__file__).with_name('hymt-openvino-manifest.json').read_text('utf-8'))
        return runtime(record)

    def resolve_device(self, device):
        return 'NPU' if device == 'NPU' else super().resolve_device(device)

    def server_arguments(self, requested):
        args = super().server_arguments('CPU')
        # OpenVINO selects its device via the environment, never llama --device.
        args[args.index('-ngl') + 1] = '99'
        args.append('--no-warmup')
        if requested == 'NPU':
            args[args.index('-c') + 1] = '2048'
            args[args.index('-b') + 1] = '128'
        return args

    def process_environment(self, requested):
        env = os.environ.copy()
        for key in list(env):
            if key.startswith('GGML_OPENVINO_'): env.pop(key)
        env.update({'GGML_OPENVINO_DEVICE': requested,
                    'GGML_OPENVINO_STATEFUL_EXECUTION': '0',
                    # Hunyuan graph signatures in b11429 reuse incompatible
                    # fixed embedding-input shapes across prefill/decode.
                    'GGML_OPENVINO_DISABLE_CACHE': '1',
                    'GGML_OPENVINO_MEMORY_OPTIMIZE': '1', 'OMP_NUM_THREADS': '2'})
        return env

    def actual_device(self, requested, log):
        match = re.search(r'using device OPENVINO\d+ \(GGML_OPENVINO_DEVICE=(CPU|GPU(?:\.\d+)?|NPU)\b', log)
        if not match or not re.search(r'offloaded [1-9]\d*(?:/\d+)? layers', log):
            raise RuntimeError('OpenVINO did not confirm device offload')
        actual = match.group(1).split('.')[0]
        if actual != requested:
            raise RuntimeError('OpenVINO selected an unexpected device')
        return actual
