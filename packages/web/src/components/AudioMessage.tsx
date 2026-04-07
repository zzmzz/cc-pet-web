import { useMemo } from "react";
import type { ChatAudio } from "@cc-pet/shared";

interface Props {
  audio: ChatAudio;
  timestamp: number;
}

const MIME_MAP: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
  m4a: "audio/mp4",
  webm: "audio/webm",
  flac: "audio/flac",
};

export function AudioMessage({ audio, timestamp }: Props) {
  const audioUrl = useMemo(() => {
    const mime = MIME_MAP[audio.format] ?? `audio/${audio.format}`;
    return `data:${mime};base64,${audio.data}`;
  }, [audio.data, audio.format]);

  return (
    <div className="max-w-[85%] rounded-2xl bg-gray-100 px-4 py-2.5 rounded-bl-md">
      <audio controls preload="metadata" className="max-w-full" style={{ height: 36 }}>
        <source src={audioUrl} />
      </audio>
      <div className="text-[10px] mt-1 text-gray-400">
        {new Date(timestamp).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </div>
    </div>
  );
}
