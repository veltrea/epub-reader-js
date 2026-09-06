"""ファイルを、指定した窓へ「落とす」。マウスを使わない。

**なぜマウスでやらないか（2026-09-03 に実測）:**
Windows のファイルの受け渡しは OLE の `DoDragDrop` で動く。これは
「ボタンを押したあと、判定の距離を超えて動いた」ことを **送る側のアプリが自分の
メッセージの処理の中で見て** 始める作りである。外からマウスの動きを合成しても、
送る側（エクスプローラー等）がその機会を得られないので、ドラッグそのものが始まらない。
待ち時間を入れても、移動を入力イベントとして送っても、始まらなかった。

**`IDropTarget` を直に呼ぶ道も、試したが行き止まりだった。**
窓のプロパティ `OleDropTargetInterface` からポインタは取れる。しかし
**COM のポインタはそのプロセスの中でしか通じない。** 別のプロセスから呼ぶと
アクセス違反で止まる（実測。終了コード 0xC0000005）。

**そこで `WM_DROPFILES` を送る。** これは窓のメッセージなので、プロセスをまたげる。
受け取る側が `DragAcceptFiles` を呼んでいれば届く。**呼んでいなければ届かない**ので、
それも含めて「このアプリがどちらの方式で受け取る作りか」を確かめる道具になる。

使い方:
    python drop-files.py <hwnd> <x> <y> <ファイル1> [ファイル2 ...]

  hwnd : 落とす先の窓（loophole_window の list で分かる）
  x, y : 落とす位置。**窓の中の座標**（クライアント座標）
出力: 1 行の JSON
"""
import ctypes
import json
import struct
import sys
from ctypes import wintypes

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# **戻り値と引数の型を必ず指定すること。** 指定しないと ctypes は 32 ビットの整数と
# みなすので、64 ビットの Windows ではポインタが切り詰められて失敗する
# （GlobalLock が 0 を返す、という形で現れる。2026-09-03 に実測）。
kernel32.GlobalAlloc.restype = ctypes.c_void_p
kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
kernel32.GlobalFree.restype = ctypes.c_void_p
kernel32.GlobalFree.argtypes = [ctypes.c_void_p]
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, ctypes.c_void_p, ctypes.c_void_p]
user32.IsWindow.argtypes = [wintypes.HWND]

WM_DROPFILES = 0x0233
GMEM_MOVEABLE = 0x0002
GMEM_ZEROINIT = 0x0040


def build_dropfiles(paths, x, y):
    """DROPFILES 構造体とファイル名の並びを、移動可能なメモリに置いて返す。

    構造体は 20 バイト（pFiles / pt.x / pt.y / fNC / fWide）。
    そのあとに、ワイド文字のファイル名を \\0 で区切って並べ、末尾をもう 1 つの \\0 で閉じる。
    """
    names = "".join(p + "\0" for p in paths) + "\0"
    body = names.encode("utf-16-le")
    header = struct.pack("<LllLL", 20, int(x), int(y), 0, 1)
    blob = header + body

    h = kernel32.GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, len(blob))
    if not h:
        raise OSError("GlobalAlloc に失敗した")
    ptr = kernel32.GlobalLock(h)
    if not ptr:
        kernel32.GlobalFree(h)
        raise OSError("GlobalLock に失敗した")
    ctypes.memmove(ptr, blob, len(blob))
    kernel32.GlobalUnlock(h)
    return h


def main():
    if len(sys.argv) < 5:
        print(json.dumps({"ok": False, "error": "usage: drop-files.py <hwnd> <x> <y> <file>..."}))
        return 2
    hwnd = int(sys.argv[1])
    x, y = int(sys.argv[2]), int(sys.argv[3])
    paths = sys.argv[4:]

    if not user32.IsWindow(wintypes.HWND(hwnd)):
        print(json.dumps({"ok": False, "error": f"窓が見つからない: {hwnd}"}))
        return 1

    h = build_dropfiles(paths, x, y)
    # PostMessage で送る。受け取った側がメモリを解放する決まりなので、こちらでは解放しない。
    ok = user32.PostMessageW(wintypes.HWND(hwnd), WM_DROPFILES, ctypes.c_void_p(h), None)
    if not ok:
        kernel32.GlobalFree(h)
        err = ctypes.get_last_error()
        print(json.dumps({"ok": False, "error": f"PostMessage に失敗した (GetLastError={err})"}))
        return 1

    print(json.dumps({
        "ok": True,
        "sent": "WM_DROPFILES",
        "hwnd": hwnd,
        "at": [x, y],
        "files": paths,
        "note": "送っただけ。受け取ったかどうかは、アプリ側で確かめること",
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
