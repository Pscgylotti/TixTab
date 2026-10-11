# Offline Pinyin keyboard

TixTab uses the headless matching engine from **pinyin-ime 1.0.2** (MIT), derived from its published source map. The dictionary type is inlined and the prefix cache is limited to 96 entries. The Lit UI and DOM controller are not used. Source: https://github.com/CatcherInSky/pinyin-ime

The bundled Google Pinyin dictionary comes from that package, derived from **web-pinyin-ime** and the Android Open Source Project PinyinIME dictionary (Apache 2.0). Source: https://github.com/dongyuwei/web-pinyin-ime

See PINYIN-ENGINE-LICENSE.txt and PINYIN-DICTIONARY-LICENSE.txt for the complete license notices.

Lookup runs in a dedicated worker. The word list is packaged in both full and lite builds, works offline, and is loaded only when the Pinyin keyboard opens. Closing the keyboard or leaving Pinyin mode releases the worker and its indexes. No text is uploaded. This is a dictionary-based IME with word/phrase candidates, not a neural language model or a replacement for all features of a system IME.
