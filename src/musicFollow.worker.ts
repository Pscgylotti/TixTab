import { ScoreCqt, ScoreFollower } from './musicFollow';
import type { ScoreNote } from './musicScore';
let follower: ScoreFollower | null = null;
const cqt = new ScoreCqt();
self.onmessage = (
  event: MessageEvent<
    | {
        type: 'init';
        notes: Pick<ScoreNote, 'midi' | 'beat' | 'duration'>[];
        tempo: number;
        beat: number;
      }
    | { type: 'seek'; beat: number; tempo: number; epoch: number }
    | { type: 'audio'; samples: Float32Array; sampleRate: number; time: number; epoch: number }
  >,
) => {
  try {
    const message = event.data;
    if (message.type === 'init')
      follower = new ScoreFollower(message.notes, message.tempo, message.beat);
    else if (message.type === 'seek') follower?.reset(message.beat, message.tempo);
    else {
      const { feature, level, voiced } = cqt.extract(message.samples, message.sampleRate);
      self.postMessage({
        type: 'result',
        epoch: message.epoch,
        level,
        result: follower?.push(feature, message.time, voiced),
      });
    }
  } catch {
    self.postMessage({ type: 'error' });
  }
};
