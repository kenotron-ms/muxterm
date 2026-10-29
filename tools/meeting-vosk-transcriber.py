#!/usr/bin/env python3
"""Optional offline meeting transcriber for MUXTERM_MEETING_TRANSCRIBER.

Install vosk in the Python environment used by this script and set
MUXTERM_VOSK_MODEL to an operator-downloaded local model directory.
Muxterm passes a 16 kHz mono WAV input and a JSON output path.
"""

import json
import os
import sys
import wave

from vosk import KaldiRecognizer, Model, SetLogLevel


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: meeting-vosk-transcriber.py INPUT.wav OUTPUT.json")
    model_path = os.environ.get("MUXTERM_VOSK_MODEL", "")
    if not model_path:
        raise SystemExit("MUXTERM_VOSK_MODEL is not set")
    SetLogLevel(-1)
    model = Model(model_path)
    segments = []
    with wave.open(sys.argv[1], "rb") as audio:
        recognizer = KaldiRecognizer(model, audio.getframerate())
        recognizer.SetWords(True)

        def add(result_json: str) -> None:
            result = json.loads(result_json)
            words = result.get("result", [])
            text = result.get("text", "").strip()
            if words and text:
                segments.append(
                    {
                        "startMs": round(words[0]["start"] * 1000),
                        "endMs": round(words[-1]["end"] * 1000),
                        "text": text,
                    }
                )

        while data := audio.readframes(4000):
            if recognizer.AcceptWaveform(data):
                add(recognizer.Result())
        add(recognizer.FinalResult())
    with open(sys.argv[2], "w", encoding="utf-8") as output:
        json.dump({"segments": segments}, output)


if __name__ == "__main__":
    main()
