"""Human-triggered sync using the current user's existing Fleet console or a local selection."""
import getpass
import json
import os
from http.cookiejar import CookieJar
from pathlib import Path
import sys
from urllib.parse import quote, urlsplit
from urllib.request import build_opener, HTTPCookieProcessor, ProxyHandler, Request
import profile_sync as sync

def fetch_selection(home):
    url = os.getenv("FLEET_HUB_URL")
    if not url:
        url = sync.read_json(home/"fleet-desktop/config.json", {}).get("hub_url")
    if not url:
        raise ValueError("未找到此设备的 Fleet Hub 地址，请设置 FLEET_HUB_URL。")
    addr = urlsplit(url)
    if addr.scheme not in ("http","https") or not addr.hostname or addr.username or addr.password or addr.query or addr.fragment:
        raise ValueError("无效的 Fleet Hub 地址")
    api = url.rstrip("/")+"/api/"
    client = build_opener(ProxyHandler({}),sync.NoRedirect(),HTTPCookieProcessor(CookieJar()))
    key = os.getenv("FLEET_API_KEY")
    headers = {"Authorization":"Bearer "+key} if key else {}
    def request(route, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = Request(api+route, data=data,headers={**headers,"Content-Type":"application/json"})
        with client.open(req,timeout=15) as res:
            resp = res.read(2_000_001)
            if len(resp)>2_000_000:
                raise ValueError("清单过大")
            return json.loads(resp) if resp else {}
    if not key:
        print("登录现有 Fleet 控制台",url)
        request("login",{"password":getpass.getpass("Fleet 管理员密码（本次使用）：")})
    try:
        devices=request("nodes")
        for i,n in enumerate(devices,1):
            print(i,n["alias"],"在线" if n["online"] else "离线")
        index=int(input("源设备编号："))-1
        if not 0<=index<len(devices):
            raise ValueError("无效编号")
        return request("nodes/"+quote(devices[index]["id"],safe="")+
                       "/volumes/inbox/download?path="+sync.FILENAME)
    finally:
        if not key:
            request("logout",{})

def main(inbox):
    home=Path(os.environ.get("DSH_HOME") or Path.home()/".dsh").resolve()
    print("1 发布本机插件清单   2 从 Fleet 设备同步   3 从已有清单同步")
    action=input("选择：").strip()
    if action=="1":
        file=inbox/sync.FILENAME
        sync.atom(file,sync.encoded(sync.inventory(home)));print("已发布",file);return
    if action=="2":
        doc=fetch_selection(home)
    elif action=="3":
        doc=sync.read_json(Path(input("清单路径：").strip().strip('"')))
    else:
        return
    names=sorted(doc["packages"])
    for idx,n in enumerate(names,1):
        print(idx,n,doc["packages"][n]["version"])
    raw=input("输入 all 选全部，或输入一个或多个编号（空格分隔）：").strip()
    if raw=="all":
        chosen=None
    else:
        nums=[int(x) for x in raw.split()]
        if not nums or any(x<1 or x>len(names) for x in nums):
            raise ValueError("无效选择")
        chosen=[names[i-1] for i in nums]
    entries=sync.selection(doc,chosen)
    sync.apply(home,entries,False)
    if input("在目标机保存会话并退出 DSH Desktop 后，输入 APPLY 应用：")!="APPLY":
        return
    import psutil
    if any((p.info["name"] or "").lower()=="deepseek harness.exe" for p in psutil.process_iter(["name"])):
        raise RuntimeError("DSH Desktop 仍在运行。请从托盘退出后再同步。")
    root=home/"lan-sync";root.mkdir(exist_ok=True)
    lock=root/"profile-update.lock"
    handle=lock.open("x")
    try:
        skipped=sync.apply(home,entries,True)
    finally:
        handle.close();lock.unlink(missing_ok=True)
    print("已应用。需原安装器的本地包：",", ".join(sorted(skipped)) or "无")
    print("重新打开 DSH Desktop，并在此菜单发布新清单。")

if __name__=="__main__":
    try:
        main(Path(sys.argv[1]).resolve())
    except (Exception, KeyboardInterrupt) as exc:
        print("同步已停止：",exc)
        raise SystemExit(1)
