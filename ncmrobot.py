#coding=utf-8
import yaml
from stat import S_ISREG, ST_CTIME, ST_MODE
import os, sys, time
from os.path import expanduser
import ntpath
import subprocess
import ctypes


FO_DELETE = 0x0003
FOF_ALLOWUNDO = 0x0040
FOF_NOCONFIRMATION = 0x0010
FOF_SILENT = 0x0004


class SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [
        ("hwnd", ctypes.c_void_p),
        ("wFunc", ctypes.c_uint),
        ("pFrom", ctypes.c_wchar_p),
        ("pTo", ctypes.c_wchar_p),
        ("fFlags", ctypes.c_ushort),
        ("fAnyOperationsAborted", ctypes.c_bool),
        ("hNameMappings", ctypes.c_void_p),
        ("lpszProgressTitle", ctypes.c_wchar_p),
    ]


def send_to_recycle_bin(path):
    if os.name != "nt":
        raise OSError("Recycle bin support is only implemented for Windows")

    operation = SHFILEOPSTRUCTW()
    operation.wFunc = FO_DELETE
    operation.pFrom = path + "\0\0"
    operation.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT

    result = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(operation))
    if result != 0:
        raise OSError(f"Failed to recycle file {path}, code={result}")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

home = expanduser("~")

configFilePath = "./user_config.yml"
configTempFilePath = "./config/config.yml"

config = None
CONFIG_KEY_FOLDER = "folder"
CONFIG_KEY_LAST_TS = "last_timestamp"

if os.path.isfile(configFilePath):
    print("The user config file existing!! Use it.")
else:
    with open(configTempFilePath, encoding='utf-8') as infile:
        config = yaml.safe_load(infile)

    userPathIni = home + "/Music/网易云音乐"
    config[CONFIG_KEY_FOLDER] = userPathIni
    with open(configFilePath, 'w', encoding='utf-8') as outfile:
        yaml.dump(config, outfile, default_flow_style=False, allow_unicode=True)

with open(configFilePath, encoding='utf-8') as infile:
    config = yaml.safe_load(infile)

dirPath = config.get(CONFIG_KEY_FOLDER)
print(dirPath)

if not os.path.isdir(dirPath):
    raise FileNotFoundError("Music folder does not exist: " + dirPath)

# get all entries in the directory w/ stats
entries = (os.path.join(dirPath, fn) for fn in os.listdir(dirPath) if fn.endswith(".ncm"))
entries = ((os.stat(path), path) for path in entries)

# leave only regular files, insert creation date
entries = ((stat[ST_CTIME], path)
           for stat, path in entries if S_ISREG(stat[ST_MODE]))
# NOTE: on Windows `ST_CTIME` is a creation date
#  but on Unix it could be something else
# NOTE: use `ST_MTIME` to sort by a modification date
lastTS = config[CONFIG_KEY_LAST_TS]
newLastTS = lastTS
sumHandle = 0
sumRecycled = 0
dump_executable = "./ncmdump.exe" if os.name == "nt" else "./ncmdump"
for cdate, path in sorted(entries):
    mp3_path = os.path.splitext(path)[0] + ".mp3"

    if os.path.isfile(mp3_path):
        print("### Recycle source file because mp3 exists:", ntpath.basename(path))
        send_to_recycle_bin(path)
        sumRecycled = sumRecycled + 1
        continue

    # print(cdate)
    # print(time.ctime(cdate), os.path.basename(path), os.name)
    if cdate > lastTS:
        fileToConvert = ntpath.basename(path)
        print("### Start to convert the file: ", cdate, "-", fileToConvert)
        subprocess.run([dump_executable, path], check=True)
        sumHandle = sumHandle + 1
        if os.path.isfile(mp3_path):
            print("### Recycle source file after conversion:", fileToConvert)
            send_to_recycle_bin(path)
            sumRecycled = sumRecycled + 1
    if cdate > newLastTS:
        newLastTS = cdate

print("new last time stamp: ", newLastTS, "time: ", time.ctime(newLastTS))
print("sum of handle this time: ", sumHandle)
print("sum of recycled ncm this time: ", sumRecycled)

config[CONFIG_KEY_LAST_TS] = newLastTS
with open(configFilePath, 'w', encoding='utf-8') as outfile:
    yaml.dump(config, outfile, default_flow_style=False, allow_unicode=True)
