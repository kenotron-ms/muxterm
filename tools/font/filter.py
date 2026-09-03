"""Drop glyphs whose advance width differs from the modal one, so the
converted font is strictly monospace."""
import sys, collections
src, dst = sys.argv[1], sys.argv[2]
lines = open(src, encoding="latin-1").read().splitlines()
adv = collections.Counter()
for l in lines:
    if l.startswith("DWIDTH"):
        adv[int(l.split()[1])] += 1
modal = adv.most_common(1)[0][0]
out, i, kept, dropped = [], 0, 0, 0
while i < len(lines):
    l = lines[i]
    if l.startswith("STARTCHAR"):
        e = i
        while not lines[e].startswith("ENDCHAR"):
            e += 1
        blk = lines[i:e+1]
        w = next(int(b.split()[1]) for b in blk if b.startswith("DWIDTH"))
        if w == modal:
            out += blk; kept += 1
        else:
            dropped += 1
        i = e + 1
        continue
    out.append("CHARS PLACEHOLDER" if l.startswith("CHARS ") else l)
    i += 1
open(dst, "w", encoding="latin-1").write(
    "\n".join(out).replace("CHARS PLACEHOLDER", f"CHARS {kept}") + "\n")
print(f"{dst}: modal advance {modal}, kept {kept}, dropped {dropped} ({dict(adv)})")
