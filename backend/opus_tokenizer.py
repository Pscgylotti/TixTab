"""Match the installed Transformers.js Marian tokenizer's approximate nmt_nfkc.

The bundled tokenizer JSON has a null SentencePiece precompiled charsmap; the
Rust library cannot load it. Normalize explicitly, then retain its Unigram model,
metaspace pretokenizer, added vocabulary and EOS postprocessor unchanged.
"""
import json
import re
import unicodedata
from tokenizers import Tokenizer

REMOVE = re.compile('[\u0001-\u0008\u000b\u000e-\u001f\u007f\u008f\u009f]')
SPACES = re.compile('[\u0009\u000a\u000c\u000d\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u2581\u3000\ufeff\ufffd]')


def normalize(text):
    text = SPACES.sub(' ', REMOVE.sub('', text))
    return '\uff5e'.join(unicodedata.normalize('NFKC', part) for part in text.split('\uff5e'))


class OpusTokenizer:
    def __init__(self, folder):
        data = json.loads((folder / 'tokenizer.json').read_text('utf-8'))
        data['normalizer'] = None
        self.tokenizer = Tokenizer.from_str(json.dumps(data))

    def encode(self, text, direction):
        ids = self.tokenizer.encode(normalize(text)).ids
        if direction == 'en-zh':
            language = self.tokenizer.token_to_id('>>cmn_Hans<<')
            if language is None:
                raise ValueError('Missing Chinese language token')
            ids.insert(0, language)
        return ids

    def decode(self, ids):
        return self.tokenizer.decode(ids, skip_special_tokens=True).strip()
