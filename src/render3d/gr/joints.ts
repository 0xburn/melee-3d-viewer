/* 3D replay viewer: a stage's joints as the game posed them, from the
 * viewer track ("sp").
 *
 * The simulator writes each stage part's joints as its animations and its
 * code left them at the frame's end: Fountain of Dreams' platforms, Yoshi's
 * Story's, Pokemon Stadium's, the backgrounds. With them the parts stand as
 * the game had them, over what the viewer plays and works out itself. A
 * value of a joint sent is at its file's rest until it is sent itself; a
 * joint never sent (still at rest in the game, or one the simulator does not
 * write: a quaternion's) keeps the viewer's own pose. The track counts a
 * part's joints from the joint the game puts above the file's root
 * (Ground_801C14D0's scale joint, the part's place here): the file's root,
 * the part's joint 0 here, is its 1.
 */
import type { Part, Stage, StageLogic } from "../stage";
import type { ViewerTrack } from "../track";

export class TrackJoints implements StageLogic {
  /** the stage objects' numbers the track may name: the parts', its other forms', the copies' */
  private numbers: number[] | null = null;

  constructor(private tr: ViewerTrack) {}

  apply() {}

  pose(st: Stage, frame: number) {
    if (!this.tr.valid(frame - 123)) return;
    if (!this.numbers) {
      const all = new Set<number>(st.parts.map((p) => p.index));
      for (const parts of st.forms.values()) for (const p of parts) all.add(p.index);
      for (const n of st.named.keys()) all.add(n);
      this.numbers = [...all];
    }
    for (const n of this.numbers) {
      const part = st.named.get(n) ?? st.partOf(n);
      if (!part) continue;
      const pose = this.tr.pose("sp", String(n), frame - 123);
      if (pose) layStageJoints(part, pose.joints);
    }
  }
}

/** a part's joints from the track's (by its count, the file's root 1), a value not sent at the file's rest */
export function layStageJoints(part: Part, joints: Map<number, Float32Array>) {
  const sk = part.skeleton;
  for (const [j, v] of joints) {
    const i = j - 1;
    if (i < 0 || i >= sk.n) continue;
    const rest = part.joints[i];
    for (let k = 0; k < 3; k++) {
      sk.rot[i * 3 + k] = Number.isNaN(v[k]) ? rest.rot[k] : v[k];
      sk.scale[i * 3 + k] = Number.isNaN(v[3 + k]) ? rest.scale[k] : v[3 + k];
      sk.trans[i * 3 + k] = Number.isNaN(v[6 + k]) ? rest.trans[k] : v[6 + k];
    }
  }
  // (a part the file has no animation for stands still, unless the game moves it)
  if (joints.size) part.still = false;
}
