"""Real PCM regression tests. Reuses the verified local integration-test bank.

Set TIXTAB_FOLLOW_TEST_ASSETS to a directory containing synth/ and GeneralUser-GS.sf2.
Run with the existing managed homr Python; no model or runtime is downloaded here.
"""
import base64
import contextlib
import io
import os
import json
from pathlib import Path
import unittest

import numpy as np
from matchmaker_runner import GlobalFollowing

ASSETS = Path(os.environ.get('TIXTAB_FOLLOW_TEST_ASSETS',
                             Path(__file__).resolve().parents[1]/'.cache/follow-correction'))


@unittest.skipUnless((ASSETS/'GeneralUser-GS.sf2').is_file() and (ASSETS/'synth').is_dir(),
                     'verified local score-following audio assets not available')
class FollowingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pitches = np.random.default_rng(63).integers(54, 83, 72).tolist()
        cls.pitches[8:14] = cls.pitches[48:54] = [60, 64, 67, 62, 69, 65]
        cls.notes = [dict(midi=p, beat=i, duration=.8) for i, p in enumerate(cls.pitches)]
        with contextlib.redirect_stdout(io.StringIO()):
            cls.f = GlobalFollowing(dict(notes=cls.notes, tempo=120), str(ASSETS/'synth'),
                                    str(ASSETS/'GeneralUser-GS.sf2'))
        import fluidsynth
        cls.synth = fluidsynth.Synth(samplerate=16000., gain=.7)
        sf = cls.synth.sfload(str(ASSETS/'GeneralUser-GS.sf2'))
        cls.synth.program_select(0, sf, 0, 1)  # Reference uses program 0.
        cls.synth.setting('synth.reverb.active', 0)
        cls.synth.setting('synth.chorus.active', 0)

    @classmethod
    def tearDownClass(cls):
        cls.synth.delete()

    def setUp(self):
        self.f.reset(0, 0)
        self.synth.cc(0, 120, 0)
        self.stamp = 0
        self.rng = np.random.default_rng(91)

    def send(self, pcm, noise=.0006):
        self.stamp += len(pcm)/16000
        pcm = (pcm+self.rng.normal(0, noise, len(pcm))).astype('<f4')
        return self.f.audio(dict(epoch=0, time=self.stamp, pcm=base64.b64encode(pcm).decode()))

    def play(self, start, count, period=.64):
        result = []
        for i in range(start, start+count):
            self.synth.noteon(0, self.pitches[i], 90)
            for j in range(round(period/.04)):
                if j == round(period/.04)-3:
                    self.synth.noteoff(0, self.pitches[i])
                pcm = self.synth.get_samples(640).reshape(-1, 2).mean(axis=1)/32768
                result.append((i, self.send(pcm)))
        return result

    def assert_located(self, result):
        self.assertTrue(any(r['state'] == 'matched' and abs(r['beat']-i) < .5 for i, r in result))
        self.assertLess(abs(self.f.beat-result[-1][0]), 1.1)

    def test_arbitrary_start_pause_resume_and_backwards_jump(self):
        self.assert_located(self.play(29, 9))
        held = self.f.beat
        self.synth.cc(0, 120, 0)
        for _ in range(75):
            r = self.send(np.zeros(640))
            self.assertEqual(r['state'], 'listening')
            self.assertEqual(r['beat'], held)
        self.assert_located(self.play(38, 5, .48))
        self.assert_located(self.play(18, 8, .40))

    def test_repeated_phrase_stays_ambiguous_until_distinct_notes(self):
        result = self.play(48, 4, .48)
        self.assertFalse(any(r['state'] == 'matched' for _, r in result))
        self.assertEqual(self.f.beat, 0)
        self.assert_located(self.play(52, 7, .48))

    def test_noise_stale_epoch_and_single_short_packet_do_not_navigate(self):
        for _ in range(100):
            r = self.send(np.zeros(640), noise=.01)
            self.assertNotEqual(r['state'], 'matched')
        before = self.f.probabilities.copy()
        r = self.f.audio(dict(epoch=999, pcm='', time=self.stamp+1))
        self.assertEqual(r['state'], 'stale')
        np.testing.assert_array_equal(before, self.f.probabilities)
        self.f.reset(12, 0, manual=True)
        self.send(np.zeros(320))
        self.assertEqual(self.f.beat, 12)

    def test_long_score_has_linear_storage_and_no_growing_audio_history(self):
        notes = [dict(midi=54+i % 30, beat=i*.1, duration=.08) for i in range(10000)]
        with contextlib.redirect_stdout(io.StringIO()):
            f = GlobalFollowing(dict(notes=notes, tempo=120), str(ASSETS/'synth'),
                                str(ASSETS/'GeneralUser-GS.sf2'))
        arrays = [v for v in vars(f.hmm).values() if isinstance(v, np.ndarray)]
        arrays += f.hmm._alpha_diags
        self.assertLess(sum(v.nbytes for v in arrays), 6*1024*1024)
        self.assertEqual(f.extractor.ring.size, 8192)
        self.assertFalse(hasattr(f.hmm, '_alignment_path'))

    def test_one_held_distant_chord_cannot_relocate_and_restart_clears_live_state(self):
        self.assert_located(self.play(29, 9))
        held = self.f.beat
        self.synth.cc(0, 120, 0)
        self.synth.noteon(0, self.pitches[-1], 90)
        for _ in range(100):
            pcm = self.synth.get_samples(640).reshape(-1, 2).mean(axis=1)/32768
            self.send(pcm)
            self.assertLess(abs(self.f.beat-held), 8)
        self.assertLessEqual(len(self.f.phrase), 32)
        templates = self.f.hmm._log_templates
        kernels = self.f.extractor.kernels
        self.f.reset(12, 7)
        self.assertIs(self.f.hmm._log_templates, templates)
        self.assertIs(self.f.extractor.kernels, kernels)
        self.assertEqual(len(self.f.phrase), 0)
        self.assertFalse(self.f.extractor.ring.any())
        self.assertIsNone(self.f.last_time)
        self.assertIsNone(self.f.relocation)
        self.assertEqual(self.f.partial.size, 0)
        stale = self.f.audio(dict(epoch=0, pcm='', time=1))
        self.assertEqual(stale['state'], 'stale')


@unittest.skipUnless(os.environ.get('TIXTAB_FOLLOW_TEST_PROJECT') and os.environ.get('TIXTAB_FOLLOW_TEST_PCM'),
                     'optional user-supplied continuous piano performance not configured')
class PerformanceRegression(unittest.TestCase):
    def test_continuous_real_performance_does_not_teleport_between_repeated_passages(self):
        project = json.loads(Path(os.environ['TIXTAB_FOLLOW_TEST_PROJECT']).read_text('utf8'))
        notes, offset, pages = [], 0, []
        for page in project['pages']:
            score = page.get('score')
            if not score:
                continue
            pages.append(offset)
            notes.extend({**n, 'beat': offset+n['beat']} for n in score['notes'] if not n.get('muted'))
            offset += score['duration']
        with contextlib.redirect_stdout(io.StringIO()):
            f = GlobalFollowing(dict(notes=notes, tempo=120), str(ASSETS/'synth'),
                                str(ASSETS/'GeneralUser-GS.sf2'))
        pcm = np.fromfile(os.environ['TIXTAB_FOLLOW_TEST_PCM'], dtype='<f4')
        last, visited, matched = 0, set(), 0
        for i in range(0, len(pcm)-639, 640):
            r = f.audio(dict(epoch=0, time=(i+640)/16000,
                             pcm=base64.b64encode(pcm[i:i+640]).decode()))
            if r['state'] == 'matched':
                self.assertLessEqual(abs(r['beat']-last), 8, f"teleport at {(i+640)/16000:.2f}s")
                last = r['beat']
                visited.add(int(np.searchsorted(pages, last, side='right')-1))
                matched += 1
        self.assertEqual(visited, set(range(len(pages))))
        self.assertGreater(matched, len(pcm)/640*.6)  # Holding forever is not a fix.
        self.assertGreater(f.beat, offset-8)


if __name__ == '__main__':
    unittest.main()
