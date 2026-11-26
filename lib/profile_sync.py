"""Export, preview and apply a Desktop plugin selection. Requires Python 3.10+ and PyYAML."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit, quote
from urllib.request import build_opener, ProxyHandler, HTTPRedirectHandler, Request
import yaml

MARKET = "@deepseek-ai/dsh-experimental-plugin-market-bundle"
START = "dsh-startup-screen"
WHALE = "dsh-whale-widget"
CONTEXT = "dsh-context"
ORCA = "@smalltailqwq/dsh-client-ui-skin-orca-link"
FLEET = "@dsh-fleet/desktop"
SYNC = "dsh-lan-sync"
FORMAT = "dsh-desktop-selection/1"
FILENAME = "desktop-plugin-selection.json"
NAME = re.compile(r"(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*\Z")
VERSION = re.compile(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?\Z")
START_KEYS = set("enabled mode theme speed requireInteraction allowSkip sound soundVolume voice voiceLang voiceName voiceRate voicePitch voiceVolume voiceCue sfx voiceSource voiceLead identity identityId accessLevel brand1 brand2 brand3a brand3b orgZh orgEn orgSub welcomeBox footer accent glitchA glitchB".split())
WHALE_KEYS = set("scale sound vol soundSet usageMode peakMode bubbleOn pressOn turnCostOn turnCostCloseMs scrollGapOn scrollGapPx menuBtnHide".split())
CONTEXT_KEYS = set("maxRequestSteps maxKeptTurns maxEvents maxNodes maxArchiveNodes maxFileOps maxCommands maxSpans maxCommandChars defaultPlacement defaultGranularity defaultTimelineMode defaultDeltaBase defaultToolSort defaultFileSort insightsEntry defaultDurationCurve overviewAutoSteps defaultOverviewRange fleetTab".split())
SETTINGS = {START: ("dsh-startup.json", START_KEYS), WHALE: (".dshw-size.json", WHALE_KEYS)}
LAUNCH_URL = "https://github.com/6shenhonghong9/dsh-startup-screen/releases/download/v1.1.1/dsh-startup-screen-1.1.1.tgz"

def read_json(path, default=None):
    return json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else default

def atom(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        f.write(data)
    try:
        os.replace(f.name, path)
    finally:
        Path(f.name).unlink(missing_ok=True)

def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()

def portable_settings(data, keys):
    return {k: v for k, v in data.items() if k in keys and type(v) in (bool, float, int, str)
            and (not isinstance(v, str) or (len(v) <= 256 and all(ord(x) >= 32 for x in v)))}

def indexes(items):
    if not isinstance(items, list):
        raise ValueError("Invalid indexes")
    accepted = []
    for value in items:
        u = urlsplit(value)
        if u.scheme != "https" or not u.hostname or u.username or u.password or u.query or u.fragment:
            raise ValueError("Index requires a clean HTTPS address")
        if value not in accepted:
            accepted.append(value)
    return accepted

def profile(home):
    return home / "profiles" / "desktop"

def version(home, name):
    m = read_json(profile(home) / "node_modules" / name / "package.json", {})
    return m.get("version") if m.get("name") == name else None

def read_rows(path):
    rows = yaml.safe_load(path.read_text(encoding="utf-8-sig")) if path.exists() else []
    if rows is None:
        rows = []
    if not isinstance(rows, list):
        raise ValueError("Unsupported profile patch")
    return rows

def inventory(home):
    manifest = read_json(profile(home) / "package.json")
    registered = manifest["dsh"]["profile"]["bundles"]
    rows = {}
    for path in (home / "cordis.patch.yml", profile(home) / "cordis.patch.yml"):
        for row in read_rows(path):
            if isinstance(row, dict) and isinstance(row.get("config"), dict):
                rows.setdefault(row.get("id"), {}).update(row["config"])
    packages = {}
    for name in sorted(set(registered) | set(manifest.get("dependencies", {}))):
        if not NAME.fullmatch(name):
            continue
        installed = version(home, name)
        if name == MARKET and name in registered and not installed:
            installed = "native"
        if installed != "native" and (not installed or not VERSION.fullmatch(installed)):
            continue
        spec = manifest.get("dependencies", {}).get(name, "")
        cache = home / "lan-sync" / "packages"
        cached = spec.startswith("file:") and any(
            path.is_file() and (cache / path.name).resolve() == path.resolve()
            for path in [(profile(home) / spec[5:])])
        registry = bool(re.fullmatch(r"[~^]?\d+\.\d+\.\d+(?:-[\w.-]+)?", spec))
        entry = {"version": installed, "registered": name in registered,
                 "source": "registry" if registry else "local"}
        if name == START and installed == "1.1.1" and (spec == LAUNCH_URL or cached):
            entry["source"] = "startup-release"
        if cached and name not in {FLEET,SYNC,START}:
            # Only a previously verified registry archive may be resolved by registry name again.
            records = read_json(cache / "registry-origins.json", {})
            if records.get(name) == installed:
                entry["source"] = "registry"
        if name in SETTINGS:
            filename, keys = SETTINGS[name]
            path = home / filename
            if name == WHALE and not path.exists():
                path = home / "profiles" / "web" / filename
            if path.exists():
                entry["settings"] = portable_settings(read_json(path), keys)
        if name == CONTEXT:
            entry["settings"] = portable_settings(rows.get("dsh-context", {}), CONTEXT_KEYS)
        if name == MARKET:
            entry["source"] = "host-market"
            entry["indexes"] = indexes(rows.get("plugin-market", {}).get("indexes", []))
        packages[name] = entry
    return {"format": FORMAT, "captured": int(time.time()), "packages": packages}

def selection(doc, only):
    if doc.get("format") != FORMAT or not isinstance(doc.get("packages"), dict):
        raise ValueError("Unsupported manifest")
    names = sorted(set(only or doc["packages"]))
    result = {}
    for name in names:
        if not NAME.fullmatch(name) or name not in doc["packages"]:
            raise ValueError("Invalid or absent selection: " + name)
        entry = doc["packages"][name]
        native_market = name == MARKET and entry["version"] == "native" and entry["source"] == "host-market"
        if (not native_market and not VERSION.fullmatch(entry["version"])) or type(entry["registered"]) is not bool:
            raise ValueError("Invalid package metadata: " + name)
        source = entry["source"]
        if (source == "host-market" and name != MARKET) or source not in ("registry","local","startup-release","host-market") or (source == "startup-release" and (name, entry["version"]) != (START, "1.1.1")):
            raise ValueError("Unsupported package source")
        if "settings" in entry:
            keys = SETTINGS[name][1] if name in SETTINGS else CONTEXT_KEYS if name == CONTEXT else set()
            if portable_settings(entry["settings"], keys) != entry["settings"]:
                raise ValueError("Unsupported settings: " + name)
        if "indexes" in entry and (name != MARKET or indexes(entry["indexes"]) != entry["indexes"]):
            raise ValueError("Unsupported indexes")
        result[name] = entry
    return result

def cli():
    explicit = os.environ.get("DSH_SYNC_CLI")
    roots = [Path(os.environ.get("LOCALAPPDATA", ".")) / "Programs" / "DeepSeek Harness"]
    choices = [explicit] if explicit else [str(r / "resources/runtime/cli/bin/dsh.cmd") for r in roots] + [shutil.which("dsh.cmd"), shutil.which("dsh")]
    for candidate in choices:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    raise RuntimeError("Set DSH_SYNC_CLI to the installed DSH executable")

def other_skin(n):
    return (n != ORCA and not n.endswith("-skin-deep-whale-manager") and
            ("/dsh-client-ui-skin-" in n or n in {"dsh-claude-style","dsh-theme-whalegirl","dsh-dream-skin","@leon___/dsh-client-liang-intensity-skin"}))

def run_manager(home, args):
    env = {**os.environ, "DSH_HOME": str(home), "npm_config_ignore_scripts": "true"}
    try:
        executable = cli()
    except RuntimeError:
        if os.getenv("DSH_SYNC_CLI"):
            raise
        # The Fleet venv already knows the user's selected Desktop or npm SDK.
        try:
            from fleet_node.agents import dsh_command
        except ImportError as error:
            raise RuntimeError("Set DSH_SYNC_CLI to the installed DSH launcher") from error
        prefix = dsh_command(env)
    else:
        path = Path(executable)
        if path.name.lower() == "deepseek harness.exe":
            archive = path.parent / "resources" / "app.asar"
            if not archive.is_file():
                raise ValueError("Desktop runtime archive missing")
            prefix = [str(path), "--expose-internals", str(archive / "dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js")]
            env["ELECTRON_RUN_AS_NODE"] = "1"
        else:
            prefix = [executable]
    subprocess.run([*prefix, "plugin", "--profile", "desktop", *args],
                   check=True, env=env, timeout=480)

def install(home, specs):
    if specs:
        run_manager(home, ["add", "--ignore-scripts", "--prefer-offline", "--save-exact", *specs])

def apply(home, entries, approved, archives=None, orca_only=False):
    manifest_path = profile(home) / "package.json"
    manifest = read_json(manifest_path)
    original_bundles = list(manifest["dsh"]["profile"]["bundles"])
    install_specs, skipped = [], set()
    for name, e in entries.items():
        v = e["version"]
        if name == MARKET and archives is None:
            if name not in original_bundles and version(home,name) is None:
                print("Enable the Desktop's native Custom plugin indexes and retry:",name)
                skipped.add(name)
                continue
        elif version(home, name) != v:
            if archives and name in archives:
                spec = str(archives[name])
            elif e["source"] == "registry":
                spec = name + "@" + v
            elif e["source"] == "startup-release":
                spec = LAUNCH_URL
            else:
                print("Local package needs its own installer:", name)
                skipped.add(name)
                continue
            install_specs.append(spec)
        print(name, v, "registered" if e["registered"] else "dependency only",
              "settings:", len(e.get("settings", {})), "indexes:", len(e.get("indexes", [])))
    if not approved:
        return skipped
    backup = Path(tempfile.mkdtemp(prefix="apply-", dir=home / "lan-sync"))
    patch = profile(home) / "cordis.patch.yml"
    for path in [manifest_path, patch, profile(home)/"pnpm-lock.yaml",
                 *[home/SETTINGS[name][0] for name in entries if name in SETTINGS]]:
        if path.is_file():
            shutil.copy2(path, backup / path.name)
    print("Backup:", backup)
    if orca_only and (ORCA not in entries or not entries[ORCA]["registered"]):
        raise ValueError("Orca must be selected and registered")
    install(home, install_specs)
    if orca_only:
        obsolete = sorted(n for n in read_json(manifest_path).get("dependencies", {}) if other_skin(n))
        if obsolete:
            run_manager(home, ["remove", *obsolete])
    manifest = read_json(manifest_path)
    bundles = manifest["dsh"]["profile"]["bundles"]
    bundles[:] = original_bundles
    rows = read_rows(patch)
    updates = {}
    for name,e in entries.items():
        if name in skipped:
            continue
        if (archives is not None or name != MARKET) and version(home, name) != e["version"]:
            raise RuntimeError("Installed version mismatch: " + name)
        if e["registered"] and name not in bundles:
            bundles.append(name)
        if not e["registered"] and name in bundles:
            bundles.remove(name)
        if name in SETTINGS and e.get("settings"):
            path = home / SETTINGS[name][0]
            d = read_json(path, {})
            if any(d.get(k) != v for k,v in e["settings"].items()):
                atom(path, encoded({**d, **e["settings"]}))
        if name == CONTEXT and e.get("settings"):
            updates[CONTEXT] = {"config": e["settings"]}
        if name == MARKET and e.get("indexes"):
            old = next((r.get("config", {}).get("indexes", []) for r in rows if r.get("id")=="plugin-market"), [])
            updates["plugin-market"] = {"config": {"indexes": list(dict.fromkeys([*e["indexes"], *old]))}}
    if orca_only:
        if ORCA not in entries or ORCA not in bundles:
            raise ValueError("Orca must be selected and registered")
        bundles[:] = [n for n in bundles if not other_skin(n)]
        updates["ui-skin-orca-link"] = {"disabled": False}
    if read_json(manifest_path) != manifest:
        atom(manifest_path, encoded(manifest))
    write_rows(patch, updates)
    return skipped

def write_rows(path, updates):
    """Replace only the changed YAML items, keeping untouched rows and manager markers byte-for-byte."""
    if not updates:
        return
    text = path.read_text(encoding="utf-8-sig") if path.exists() else ""
    rows = read_rows(path)
    ast = yaml.compose(text)
    edits = []
    append = []
    for key, changes in updates.items():
        matches = [i for i,r in enumerate(rows) if r.get("id")==key]
        if len(matches)>1:
            raise ValueError("Duplicate profile row: "+key)
        i = matches[0] if matches else None
        old = rows[i] if i is not None else {"id":key}
        new = {**old, **changes}
        if "config" in changes:
            new["config"] = {**old.get("config", {}), **changes["config"]}
        if old == new:
            continue
        snippet = yaml.safe_dump([new],allow_unicode=True,sort_keys=False)
        if i is None:
            append.append(snippet)
        else:
            mark = ast.value[i]
            if ast.flow_style or mark.flow_style:
                raise ValueError("Unsupported inline profile. Existing file preserved.")
            start = text.rfind("\n", 0, mark.start_mark.index)+1
            def content_end(node):
                # Block collection end marks may include following comment lines.
                if isinstance(node, yaml.ScalarNode) or node.flow_style:
                    return node.end_mark.index
                children = ([part for pair in node.value for part in pair]
                            if isinstance(node, yaml.MappingNode) else node.value)
                return max(content_end(child) for child in children)
            end = content_end(mark)
            while end > start and text[end-1].isspace():
                end -= 1
            edits.append((start,end,snippet.rstrip()))
    for a,b,s in sorted(edits,reverse=True):
        text = text[:a]+s+text[b:]
    if append:
        if not rows and text.strip() in ("[]","null","~"):
            text=""
        text = text.rstrip()+"\n"+"".join(append)
    result = yaml.safe_load(text) or []
    for key,changes in updates.items():
        row = next(r for r in result if r.get("id")==key)
        for k,v in changes.items():
            if (k=="config" and any(row[k].get(f)!=val for f,val in v.items())) or (k!="config" and row.get(k)!=v):
                raise ValueError("Patch verification failed")
    if edits or append:
        atom(path,text.encode("utf8"))

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None

def from_node(alias):
    base=os.environ["FLEET_HUB_URL"].rstrip("/")
    u=urlsplit(base)
    if u.scheme not in ("http","https") or u.username or u.password or u.query or u.fragment:
        raise ValueError("Use the configured private Fleet Hub origin")
    opener=build_opener(ProxyHandler({}),NoRedirect)
    def get(path):
        req=Request(base+"/api/"+path, headers={"Authorization":"Bearer "+os.environ["FLEET_API_KEY"]})
        with opener.open(req,timeout=15) as r:
            data=r.read(2_000_001)
        if len(data)>2_000_000:
            raise ValueError("Manifest too large")
        return json.loads(data)
    matches=[n for n in get("nodes") if n["alias"]==alias]
    if len(matches)!=1:
        raise ValueError("Expected one registered node with this alias")
    return get("nodes/"+quote(matches[0]["id"],safe="")+"/volumes/inbox/download?path="+FILENAME)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action",choices=("export","preview","apply"))
    source=parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--file",type=Path)
    source.add_argument("--from-node")
    parser.add_argument("--only", action="append", help="exact plugin name; repeat to choose a batch")
    args=parser.parse_args()
    home=Path(os.environ.get("DSH_HOME") or Path.home()/".dsh").resolve()
    if args.action=="export":
        if not args.file:
            parser.error("export requires --file")
        d=inventory(home)
        d["packages"]=selection(d,args.only)
        atom(args.file,encoded(d))
        print("Published",len(d["packages"]),"packages")
        return
    d=from_node(args.from_node) if args.from_node else read_json(args.file)
    items=selection(d,args.only)
    print("Snapshot time (epoch):", d.get("captured"))
    if args.action=="apply":
        directory=home/"lan-sync"
        directory.mkdir(exist_ok=True)
        with (directory/"profile-update.lock").open("x") as lock:
            try:
                skipped=apply(home,items,True)
            finally:
                lock.close()
                (directory/"profile-update.lock").unlink(missing_ok=True)
        if skipped:
            raise SystemExit(2)
    else:
        apply(home,items,False)

if __name__=="__main__":
    main()
