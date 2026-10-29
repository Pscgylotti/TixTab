"""TixTab streaming adapter for pinned upstream Matchmaker 0.4.0 (Apache-2.0).

Only bounded float32 PCM crosses stdin. No network access, audio-device driver,
recording files, or hidden model downloads. Stop clears live state; the owner
may retain the prepared reference until its configured idle deadline.
"""
import base64
from collections import deque
import json
import os
from pathlib import Path
import sys
import time

RATE, HOP = 16000, 320


def emit(**data):
    print(json.dumps(data, separators=(',', ':'), allow_nan=False), flush=True)


def matchmaker_imports():
    # Partitura's optional FluidSynth module downloads its own bank on import.
    # Only the locally verified bank supplied by our owner may be used here.
    previous = sys.modules.get('fluidsynth')
    sys.modules['fluidsynth'] = None
    try:
        from matchmaker.prob.outer_product_hmm_audio import AudioOuterProductHMM
        return AudioOuterProductHMM
    finally:
        if previous is None:
            sys.modules.pop('fluidsynth', None)
        else:
            sys.modules['fluidsynth'] = previous


class CausalPitch:
    """Bounded, causal constant-Q magnitudes, A0-C8. Identical for bank and mic.

    No per-packet librosa padding or re-analysis of an entire performance.
    Low notes require longer windows; a sharp timing guarantee is not possible
    for bass notes. The longest retained window is 512 ms, independent of score.
    """
    def __init__(self):
        import numpy as np
        self.np = np
        self.ring = np.zeros(8192, np.float32)
        self.kernels = []
        for pitch in range(21, 109):
            frequency = 440 * 2 ** ((pitch-69)/12)
            size = min(8192, max(128, int(np.ceil(17*RATE/frequency))))
            window = np.hanning(size).astype(np.float32)
            phase = np.arange(size)*2*np.pi*frequency/RATE
            self.kernels.append((window*np.cos(phase)/window.sum(),
                                 window*np.sin(phase)/window.sum()))

    def push(self, samples):
        count = min(len(samples), len(self.ring))
        self.ring[:-count] = self.ring[count:]
        self.ring[-count:] = samples[-count:]

    def features(self):
        np = self.np
        value = np.asarray([np.hypot(self.ring[-len(a):] @ a, self.ring[-len(b):] @ b)
                            for a, b in self.kernels], dtype=np.float32)
        # Suppress the flat microphone noise floor before compressing dynamics.
        return np.maximum(value - np.median(value)*1.5, 0) ** .7


class GlobalFollowing:
    """Upstream AudioOuterProductHMM inference with bounded sparse setup.

    Its stock constructor materializes an N*N transition matrix and invokes
    implicit bank synthesis. We initialize only the diagonals consumed by its
    unchanged forward_step, using our verified bank and causal CQT templates.
    The global transition probability is enabled (upstream defaults to zero).
    """
    def __init__(self, config, synth_directory, soundfont):
        import numpy as np
        import heapq
        hmm_type = matchmaker_imports()
        self.np = np
        self.dll = os.add_dll_directory(synth_directory) if os.name == 'nt' else None
        os.environ['PATH'] = synth_directory + os.pathsep + os.environ.get('PATH', '')
        import fluidsynth
        self.extractor = CausalPitch()
        notes = sorted((n for n in config['notes'] if not n.get('muted')), key=lambda n: n['beat'])
        self.duration = max(n['beat']+n['duration'] for n in notes)
        self.tempo = config['tempo']
        if self.duration*60/self.tempo > 3600:
            raise ValueError('score-limit')
        templates = np.empty((88, 88), np.float32)
        synth = fluidsynth.Synth(samplerate=float(RATE), gain=.7)
        try:
            sfid = synth.sfload(soundfont)
            if sfid < 0:
                raise ValueError('missing-model')
            synth.program_select(0, sfid, 0, config.get('instrument', 0))
            synth.setting('synth.reverb.active', 0)
            synth.setting('synth.chorus.active', 0)
            for index in range(88):
                synth.cc(0, 120, 0)
                synth.noteon(0, index+21, 90)
                self.extractor.ring.fill(0)
                pcm = synth.get_samples(8192).reshape(-1, 2).mean(axis=1).astype(np.float32)/32768
                self.extractor.push(pcm)
                value = self.extractor.features()
                templates[index] = value/max(float(value.sum()), 1e-12)
                if index % 8 == 0:
                    emit(event='preparing', progress=index/88)
        finally:
            synth.delete()
        self.positions = np.unique([n['beat'] for n in notes])
        count = len(self.positions)
        # Sweep active notes, rather than rescanning all notes for every onset.
        active, expired, cursor = {}, [], 0
        chord_templates = np.empty((count, 88), np.float32)
        for i, beat in enumerate(self.positions):
            while expired and expired[0][0] <= beat:
                _, key = heapq.heappop(expired)
                active.pop(key, None)
            while cursor < len(notes) and notes[cursor]['beat'] == beat:
                n = notes[cursor]
                active[cursor] = n
                heapq.heappush(expired, (n['beat']+n['duration'], cursor))
                cursor += 1
            weights = {}
            for n in active.values():
                if 21 <= n['midi'] <= 108:
                    weights[n['midi']] = max(weights.get(n['midi'], 0), float(np.exp(-.3*(beat-n['beat']))))
            value = sum((templates[p-21]*w for p, w in weights.items()), np.zeros(88, np.float32))
            chord_templates[i] = .8*value/max(float(value.sum()), 1e-12)+.2/88
        # Deliberately don't call the upstream dense constructor. These are the
        # exact fields its forward_step and emission implementation consume.
        hmm = hmm_type.__new__(hmm_type)
        hmm.n_states = count
        hmm._log_templates = np.log(chord_templates)
        hmm.emission_beta = 12.
        hmm.pause_emission_max = .001
        hmm.D1, hmm.D2 = 0, 2
        hmm.S = np.full(count, .02)
        hmm.r = np.full(count, 1/count)
        hmm.a00 = hmm._compute_chord_self_transition_probs(self.positions, self.tempo, 25)
        hmm.a01 = (1-hmm.a00)*.05
        hmm.a11 = .999
        hmm.e0 = 1-hmm.a00-hmm.a01
        hmm.e1 = .001
        # Rows at the end are explicitly bounded; the last chord can restart
        # via the global jump term without constructing a uniform dense row.
        normal = np.full(max(0, count-1), .96)
        if count > 1:
            normal[-1] = 1
        hmm._alpha_diags = [np.full(max(0, count-2), .04*.98), normal*.98, np.zeros(count)]
        hmm._j_starts = np.maximum(0, np.arange(count)-2)
        hmm._j_ends = np.arange(count)+1
        self.hmm = hmm
        self.cos_templates = chord_templates / np.maximum(np.linalg.norm(chord_templates, axis=1, keepdims=True), 1e-12)
        self.no_jumps = np.zeros(count)
        self.reset(config.get('beat', 0), config.get('epoch', 0))

    def reset(self, beat, epoch, manual=False):
        np = self.np
        self.beat, self.epoch = beat, epoch
        self.probabilities = np.zeros(2*len(self.positions))
        self.probabilities[::2] = 1/len(self.positions)
        if manual:
            index = int(np.argmin(abs(self.positions-beat)))
            self.probabilities *= .2
            self.probabilities[index*2] += .8
        self.extractor.ring.fill(0)
        self.last_time = None
        self.silence = 0
        self.held = False
        self.locked = False
        self.partial = np.empty(0, np.float32)
        # The selected location is a useful *local* hypothesis, not a restriction
        # on the independent full-score search.
        self.local = np.zeros_like(self.probabilities)
        self.local[int(np.argmin(abs(self.positions-beat)))*2] = 1.
        self.last_progress_time = None
        self.local_candidate = beat
        self.local_hits = 0
        self.phrase = deque(maxlen=32)
        self.phrase_frames = 0
        self.relocation = None

    def confirm_position(self, index, stamp):
        """Only committed positions seed the continuous (no global jumps) tracker."""
        np = self.np
        if self.last_progress_time is None or abs(float(self.positions[index])-self.beat) > .08:
            self.last_progress_time = stamp
        self.beat = float(self.positions[index])
        self.locked = True
        self.local = np.zeros_like(self.probabilities)
        self.local[index*2] = 1.
        self.local_candidate = self.beat
        self.local_hits = 0

    def phrase_location(self, fits, stamp):
        """Bounded subsequence verification; a single held chord cannot relocate.

        Keep 2.56 seconds of feature distances, never raw microphone audio.
        The recurrence is vectorized O(window * score onsets), with no N*N
        transition matrix. It verifies the global HMM's frame hypotheses and
        can recover when recognition errors temporarily derail those hypotheses.
        """
        np = self.np
        self.phrase_frames += 1
        if self.phrase_frames % 2 == 0:
            self.phrase.append((1-fits).astype(np.float32))
        if len(self.phrase) < 16 or self.phrase_frames % 5:
            return None
        cost = self.phrase[0].copy()
        count = len(cost)
        indexes = np.arange(count)
        changes = np.zeros(count, np.int32)
        for distance in list(self.phrase)[1:]:
            candidates = np.full((3, count), np.inf, np.float32)
            candidates[0] = cost
            candidates[1, 1:] = cost[:-1]+.015
            candidates[2, 2:] = cost[:-2]+.07
            step = np.argmin(candidates, axis=0)
            changes = changes[np.maximum(0, indexes-step)]+(step > 0)
            cost = np.min(candidates, axis=0)+distance
        cost /= len(self.phrase)
        index = int(np.argmin(cost))
        best_cost = float(cost[index])
        nearby = False
        if self.locked:
            # Repeated passages need the established location as a tie-breaker.
            # Require a moving musical phrase, so a held chord cannot advance.
            neighbours = np.flatnonzero((self.positions >= self.beat-.25) & (self.positions <= self.beat+8))
            if len(neighbours):
                next_index = int(neighbours[np.argmin(cost[neighbours])])
                if (cost[next_index] <= best_cost+.06 and changes[next_index] >= 3
                        and self.positions[next_index] > self.beat+.08):
                    index, nearby = next_index, True
        beat = float(self.positions[index])
        distant = abs(self.positions-beat) > 6
        margin = float(cost[distant].min()-cost[index]) if distant.any() else 1.
        near = abs(self.positions-self.beat) <= 3
        advantage = float(cost[near].min()-cost[index]) if near.any() else 1.
        if cost[index] > .38 or changes[index] < 3 or (not nearby and margin < .025):
            self.relocation = None
            return None
        relocation = self.relocation
        if relocation is None or stamp-relocation['last'] > .3 or not -.5 <= beat-relocation['beat'] <= 3:
            relocation = dict(start=stamp, last=stamp, beat=beat)
        relocation.update(last=stamp, beat=beat)
        self.relocation = relocation
        if stamp-relocation['start'] < (.19 if nearby else .35):
            return None
        return index, advantage, nearby

    def locate(self, observation, stamp):
        """Separate global proposals from the committed local trajectory.

        Repeated chords can win a frame posterior anywhere in a piano score.
        A distant proposal must describe several *changing* onsets over time,
        and outperform the still-tracked passage before navigating the UI.
        """
        np = self.np
        fits = self.cos_templates @ (observation / max(np.linalg.norm(observation), 1e-12))
        scores = self.probabilities[::2] + self.probabilities[1::2]
        index = int(np.argmax(scores))
        candidate = float(self.positions[index])
        confidence = float(scores[index])
        distant = abs(self.positions-candidate) > 1
        rival = float(scores[distant].max()) if distant.any() else 0.
        global_good = fits[index] >= .55 and confidence >= .6 and confidence > 3*rival
        phrase_location = self.phrase_location(fits, stamp)

        local_good, local_fit, local_index = False, 0., None
        if self.local is not None:
            jumps = self.hmm.S
            self.hmm.S = self.no_jumps
            try:
                self.local = self.hmm.forward_step(self.local, observation)
            finally:
                self.hmm.S = jumps
            local_scores = self.local[::2] + self.local[1::2]
            local_index = int(np.argmax(local_scores))
            local_beat = float(self.positions[local_index])
            local_fit = float(fits[local_index])
            self.local_hits = self.local_hits+1 if -.5 <= local_beat-self.local_candidate <= 2 else 0
            self.local_candidate = local_beat
            local_good = (local_fit >= .55 and local_scores[local_index] >= .4
                          and local_beat >= self.beat and self.local_hits >= 3
                          and (self.locked or (global_good and abs(candidate-local_beat) <= 1)))

        # A short match near the established path is enough for normal following;
        # acquisition and distant relocation require a coherent musical phrase.
        near = self.locked and -.5 <= candidate-self.beat <= 2
        if global_good and near:
            self.confirm_position(index, stamp)
            return 'matched', confidence

        if phrase_location is not None:
            located, advantage, nearby = phrase_location
            stalled = self.last_progress_time is not None and stamp-self.last_progress_time > .5
            if not local_good or advantage > .08 or (nearby and stalled):
                self.confirm_position(located, stamp)
                self.probabilities = self.local.copy()
                return 'matched', confidence
        if local_good:
            if self.last_progress_time is None or abs(float(self.positions[local_index])-self.beat) > .08:
                self.last_progress_time = stamp
            self.beat = float(self.positions[local_index])
            self.locked = True
            return 'matched', float(local_scores[local_index])
        return 'uncertain', confidence

    def audio(self, request):
        np = self.np
        if request['epoch'] != self.epoch:
            return dict(state='stale', epoch=self.epoch)
        data = base64.b64decode(request['pcm'], validate=True)
        if len(data) not in (HOP*4, HOP*8):
            raise ValueError('invalid')
        pcm = np.frombuffer(data, '<f4')
        if not np.isfinite(pcm).all() or np.max(np.abs(pcm)) > 4:
            raise ValueError('invalid')
        stamp = float(request['time'])
        if not np.isfinite(stamp) or (self.last_time is not None and stamp <= self.last_time):
            return dict(state='stale', epoch=self.epoch)
        if self.last_time is not None and stamp-self.last_time > .25:
            # Dropped audio invalidates confidence, not the displayed position.
            self.reset(self.beat, self.epoch)
        self.last_time = stamp
        started = time.perf_counter()
        # The HMM is calibrated at 25 Hz. Combine short packets without making
        # 20 ms callers advance the duration model twice as quickly.
        if self.partial.size:
            pcm = np.concatenate((self.partial, pcm))
        if len(pcm) < 640:
            self.partial = pcm.copy()
            return dict(state='uncertain', beat=self.beat, epoch=self.epoch,
                        level=float(np.sqrt(np.mean(pcm**2))), time=stamp, latencyMs=0.)
        self.partial = pcm[640:].copy()
        pcm = pcm[:640]
        level = float(np.sqrt(np.mean(pcm**2)))
        self.extractor.push(pcm)
        state, confidence = 'uncertain', 0.
        if level < .003:
            self.silence += len(pcm)/RATE
            state = 'listening'
            if self.silence >= .3 and not self.held:
                # Stop without a wall-clock advance. Preserve all score hypotheses
                # in pause states, including ambiguous repeated passages.
                self.probabilities[1::2] += self.probabilities[::2]
                self.probabilities[::2] = 0
                self.held = True
                self.extractor.ring.fill(0)
                self.phrase.clear()
                self.relocation = None
        else:
            if self.held:
                self.probabilities[::2] += self.probabilities[1::2]
                self.probabilities[1::2] = 0
                # A player can restart anywhere after a pause. Keep the old
                # position as a prior, and give every score position a chance.
                self.probabilities *= .8
                self.probabilities[::2] += .2/len(self.positions)
                self.held = False
            self.silence = 0
            observation = self.extractor.features()
            if observation.sum() > 1e-8:
                self.probabilities = self.hmm.forward_step(self.probabilities, observation)
                state, confidence = self.locate(observation, stamp)
        return dict(state=state, beat=min(self.duration, self.beat), confidence=confidence,
                    epoch=self.epoch, level=level, time=stamp,
                    latencyMs=(time.perf_counter()-started)*1000)


class Following:
    def __init__(self, config, synth_directory, soundfont):
        import numpy as np
        # Partitura attempts a legacy FTP download when its optional FluidSynth
        # import succeeds. We own synthesis and the verified local soundfont;
        # load Matchmaker with that unused optional integration disabled.
        previous = sys.modules.get('fluidsynth')
        sys.modules['fluidsynth'] = None
        try:
            from matchmaker.features.audio import LogSpectralEnergyProcessor
            from matchmaker.dp import OnlineTimeWarpingArztFrame
        finally:
            if previous is None:
                sys.modules.pop('fluidsynth', None)
            else:
                sys.modules['fluidsynth'] = previous
        # pyfluidsynth resolves through PATH; retain add_dll_directory handle.
        self.dll = os.add_dll_directory(synth_directory) if os.name == 'nt' else None
        os.environ['PATH'] = synth_directory + os.pathsep + os.environ.get('PATH', '')
        import fluidsynth
        self.np, self.aligner_type = np, OnlineTimeWarpingArztFrame
        self.processor = LogSpectralEnergyProcessor(sample_rate=RATE, hop_length=HOP)
        self.tempo = config['tempo']
        self.duration = max(n['beat']+n['duration'] for n in config['notes'])
        seconds = self.duration*60/self.tempo
        if seconds > 3600:
            raise ValueError('score-limit')
        synth = fluidsynth.Synth(samplerate=float(RATE), gain=.7)
        try:
            sfid = synth.sfload(soundfont)
            if sfid < 0:
                raise ValueError('missing-model')
            synth.program_select(0, sfid, 0, config.get('instrument', 0))
            synth.setting('synth.reverb.active', 0)
            synth.setting('synth.chorus.active', 0)
            events = []
            for n in config['notes']:
                if n.get('muted'):
                    continue
                events.extend([(round(n['beat']*60/self.tempo*RATE), 1, n['midi']),
                               (round((n['beat']+n['duration'])*60/self.tempo*RATE), 0, n['midi'])])
            events.sort()
            ring = np.zeros(self.processor.n_fft, np.float32)
            features, event_index, sample = [], 0, 0
            active = {}
            total = int((seconds*RATE+self.processor.n_fft)/HOP)+1
            # Render only one hop at a time; never hold whole-piece audio in memory.
            for frame in range(total):
                end = (frame+1)*HOP
                pieces = []
                while event_index < len(events) and events[event_index][0] < end:
                    at, on, pitch = events[event_index]
                    if at > sample:
                        pieces.append(synth.get_samples(at-sample))
                        sample = at
                    count = active.get(pitch, 0)
                    if on:
                        if not count:
                            synth.noteon(0, pitch, 90)
                        active[pitch] = count+1
                    else:
                        active[pitch] = max(0, count-1)
                        if count == 1:
                            synth.noteoff(0, pitch)
                    event_index += 1
                pieces.append(synth.get_samples(end-sample))
                sample = end
                pcm = np.concatenate(pieces).reshape(-1, 2).mean(axis=1).astype(np.float32)/32768
                ring[:-HOP] = ring[HOP:]
                ring[-HOP:] = pcm
                value, _ = self.processor((ring, frame/50))
                features.append(value[0].copy())
                if frame % 1000 == 0:
                    emit(event='preparing', progress=frame/total)
            self.reference = np.ascontiguousarray(features, dtype=np.float32)
            # A causal window represents its centre, rather than its newest sample.
            self.positions = np.maximum(0, (np.arange(total)*HOP+HOP-self.processor.n_fft/2)/RATE*self.tempo/60)
        finally:
            synth.delete()
        self.ring = np.zeros(self.processor.n_fft, np.float32)
        self.history = deque(maxlen=200)
        self.reset(config.get('beat', 0), config.get('epoch', 0))

    def reset(self, beat, epoch):
        np = self.np
        offset = min(len(self.reference)-2, max(0, int(np.searchsorted(self.positions, beat))))
        ref = self.reference[offset:]
        self.offset = offset
        self.aligner = self.aligner_type(reference_features=ref, score_positions=self.positions[offset:],
            ref_frame_to_beat=self.positions[offset:], frame_rate=50, window_size=8, start_window_size=.2,
            distance_func='Euclidean', step_size=5, tempo_model=None, backward_forward=False)
        self.processor.reset()
        self.ring.fill(0)
        self.history.clear()
        self.epoch, self.beat = epoch, beat
        self.frames = 0
        self.candidate, self.candidate_hits = None, 0
        self.last_time = None
        self.silent = 0

    def audio(self, request):
        np = self.np
        if request['epoch'] != self.epoch:
            return dict(state='stale', epoch=self.epoch)
        data = base64.b64decode(request['pcm'], validate=True)
        if len(data) not in (HOP*4, HOP*8):
            raise ValueError('invalid')
        pcm = np.frombuffer(data, '<f4')
        if not np.isfinite(pcm).all() or np.max(np.abs(pcm)) > 4:
            raise ValueError('invalid')
        stamp = float(request['time'])
        if not np.isfinite(stamp) or (self.last_time is not None and stamp <= self.last_time):
            return dict(state='stale', epoch=self.epoch)
        if self.last_time is not None and stamp-self.last_time > .25:
            self.reset(self.beat, self.epoch)
        self.last_time = stamp
        level = float(np.sqrt(np.mean(pcm**2)))
        started = time.perf_counter()
        for i in range(0, len(pcm), HOP):
            self.ring[:-HOP] = self.ring[HOP:]
            self.ring[-HOP:] = pcm[i:i+HOP]
            feature, _ = self.processor((self.ring, stamp))
            if level < .003:
                self.silent += 1
                continue
            self.silent = 0
            # silence does not advance alignment, nor does it erase the known score position.
            self.beat = float(self.aligner(feature[0], stamp))
            self.frames += 1
            # Upstream retains a performance history for diagnostics / tempo rewrites.
            # Those features are unused by this plain Arzt configuration. Bound them.
            self.aligner.input_features.clear()
            self.aligner._alignment_path[:] = self.aligner._alignment_path[-2:]
            self.history.append(feature[0].copy())
            if self.frames % 50 == 0 and len(self.history) >= 100:
                self.reacquire()
        return dict(state='listening' if level < .003 else 'matched', beat=min(self.duration, self.beat),
                    epoch=self.epoch, level=level, time=stamp,
                    latencyMs=(time.perf_counter()-started)*1000)

    def reacquire(self):
        """Conservative global recovery; compare the same features over several seconds.

        Candidate consistency is required twice. The online follower stays active
        while searching and is never held behind the recovery history window.
        """
        np = self.np
        history = np.asarray(self.history)
        lags = np.arange(0, min(len(history), 150), 10)
        # Restrict searching to frames with audible reference onsets; cap work to 6000 endpoints.
        candidates = np.arange(150, len(self.reference), max(5, len(self.reference)//6000))
        if not len(candidates):
            return
        scores = np.zeros(len(candidates), np.float32)
        valid = 0
        for lag in lags:
            feature = history[-1-lag]
            if np.linalg.norm(feature) < .1:
                continue
            # Accommodate small timing differences around each reference event.
            sim = np.stack([self.reference[np.clip(candidates-lag+delta, 0, len(self.reference)-1)] @ feature
                            for delta in (-3, 0, 3)]).max(axis=0)
            scores += sim
            valid += 1
        if valid < 5:
            return
        scores /= valid
        best = int(np.argmax(scores))
        at = candidates[best]
        nearby = np.abs(self.positions[candidates]-self.beat) < 2
        local = float(scores[nearby].max()) if nearby.any() else 0.
        if scores[best] < .65 or scores[best] < local+.18 or abs(self.positions[at]-self.beat) < 4:
            self.candidate_hits = 0
            return
        candidate = float(self.positions[at])
        self.candidate_hits = self.candidate_hits+1 if self.candidate is not None and abs(candidate-self.candidate) < 4 else 1
        self.candidate = candidate
        if self.candidate_hits >= 2:
            self.reset(candidate, self.epoch)


def main():
    config = json.loads(Path(sys.argv[1]).read_text('utf-8'))
    cls = GlobalFollowing if config.get('method', 'global') == 'global' else Following
    follower = cls(config, sys.argv[2], sys.argv[3])
    # A conservative accounting of retained numeric buffers (views may count
    # twice). The owner limits parked references, not Python's entire heap.
    def array_bytes(value):
        import numpy as np
        if isinstance(value, np.ndarray):
            return value.nbytes
        if isinstance(value, (list, tuple, deque)):
            return sum(array_bytes(item) for item in value)
        return 0
    buffers = list(vars(follower).values())
    if isinstance(follower, GlobalFollowing):
        buffers.extend(vars(follower.hmm).values())
        buffers.extend(vars(follower.extractor).values())
    else:
        buffers.extend(vars(follower.aligner).values())
    reference_bytes = sum(array_bytes(value) for value in buffers)
    del buffers, config
    active = True
    emit(event='ready', referenceBytes=reference_bytes)
    for line in sys.stdin:
        if len(line) > 20000:
            raise ValueError('invalid')
        request = json.loads(line)
        if request['action'] == 'stop':
            break
        try:
            if request['action'] == 'suspend':
                follower.reset(follower.beat, follower.epoch)
                active = False
                result = dict(state='listening', epoch=follower.epoch)
            elif request['action'] in ('seek', 'restart'):
                if isinstance(follower, GlobalFollowing):
                    follower.reset(request['beat'], request['epoch'], manual=request['action'] == 'seek')
                else:
                    follower.reset(request['beat'], request['epoch'])
                active = True
                result = dict(state='listening', epoch=follower.epoch)
            elif request['action'] == 'audio':
                result = follower.audio(request) if active else dict(state='stale', epoch=follower.epoch)
            else:
                raise ValueError('invalid')
            emit(id=request['id'], ok=True, data=result)
        except Exception as error:
            print(str(error), file=sys.stderr, flush=True)
            emit(id=request['id'], ok=False, error='follow-failed')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit(event='error', error='follow-failed')
        sys.exit(1)
