import { ReplayData } from "~/common/types";
import { ReplayStub } from "~/state/selectionStore";

interface ReplayRow {
  id: number;
  created_at: string;
  file_name: string;
  played_on: string;
  num_frames: number;
  external_stage_id: number;
  is_teams: boolean;
  players: {
    player_index: number;
    connect_code: string;
    display_name: string;
    nametag: string;
    external_character_id: number;
    team_id: number;
  }[];
}

type InsertRow = Omit<ReplayRow, "created_at" | "id">;

// This viewer never fetches replays from or sends them to any server (Slippi
// Lab's share service included), so the cloud calls are inert.
export async function downloadReplay(
  name: string
): Promise<{ data: Blob | null; error: Error | null }> {
  return { data: null, error: new Error(`${name}: no cloud replays in this viewer`) };
}

export async function uploadReplay(
  file: File,
  replay: ReplayData
): Promise<{
  id: string;
  data: { path: string } | null;
  error: Error | null;
}> {
  throw new Error("this viewer never uploads replays");
}

export async function loadFromCloud(
  name: string,
  load?: (files: File[]) => Promise<void>
): Promise<File> {
  const { data, error } = await downloadReplay(name);
  if (data != null) {
    const file = new File([data], name);
    if (load !== undefined) {
      await load([file]);
    }
    return file;
  } else {
    throw error;
  }
}

export async function listCloudReplays(): Promise<ReplayStub[]> {
  // no cloud library
  return [];
}
