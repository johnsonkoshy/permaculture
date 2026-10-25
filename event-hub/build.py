"""Inline the photos into src.html as data URIs and write index.html."""
import base64
import pathlib

here = pathlib.Path(__file__).parent
html = (here / "src.html").read_text()
for img in sorted((here / "assets").iterdir()):
    mime = "image/png" if img.suffix == ".png" else "image/jpeg"
    data = base64.b64encode(img.read_bytes()).decode()
    token = "__IMG_" + img.stem.upper().replace("-", "_") + "__"
    html = html.replace(token, f"data:{mime};base64,{data}")
(here / "index.html").write_text(html)
print("wrote", here / "index.html", len(html) // 1024, "KB")
