import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import profile_sync as sync

class DesktopSyncTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.profile = sync.profile(self.home)
        (self.home/"lan-sync").mkdir()
        self.profile.mkdir(parents=True)
        self.manifest = self.profile/"package.json"
        self.names = [sync.START, sync.WHALE, sync.CONTEXT]
        for name in self.names:
            file=self.profile/"node_modules"/name/"package.json"
            sync.atom(file,sync.encoded({"name":name,"version":"1.2.3"}))
        self.manifest.write_bytes(sync.encoded({"dependencies":{n:"^1.1.0" for n in self.names},
                                                "dsh":{"profile":{"bundles":self.names}}}))
        self.start = self.home/"dsh-startup.json"
        self.start.write_bytes(sync.encoded({"mode":"daily","sound":True,"apiToken":"fixture-secret"}))
        self.widget = self.home/".dshw-size.json"
        self.widget.write_bytes(sync.encoded({"scale":1.1,"vol":0.7,"private":"keep-local"}))

    def test_whitelist_and_batch(self):
        d=sync.inventory(self.home)
        self.assertEqual(set(sync.selection(d,None)),set(self.names))
        self.assertEqual(d["packages"][sync.START]["version"],"1.2.3")
        self.assertNotIn("fixture-secret",json.dumps(d))
        self.assertNotIn("keep-local",json.dumps(d))

    def test_single_preview_apply_and_repeat(self):
        d=sync.inventory(self.home)
        selected=sync.selection(d,[sync.WHALE])
        selected[sync.WHALE]["settings"]["scale"]=1.5
        old_start=self.start.read_bytes()
        with patch.object(sync,"install",side_effect=lambda h,s:self.assertEqual(s,[])):
            sync.apply(self.home,selected,False)
            self.assertEqual(sync.read_json(self.widget)["scale"],1.1)
            sync.apply(self.home,selected,True)
            expected=self.widget.read_bytes()
            sync.apply(self.home,selected,True)
        self.assertEqual(self.widget.read_bytes(),expected)
        self.assertEqual(sync.read_json(self.widget),{"scale":1.5,"vol":0.7,"private":"keep-local"})
        self.assertEqual(old_start,self.start.read_bytes())

    def test_apply_full_batch(self):
        doc = sync.inventory(self.home)
        doc["packages"][sync.START]["settings"]["mode"] = "always"
        doc["packages"][sync.WHALE]["settings"]["scale"] = 1.4
        doc["packages"][sync.CONTEXT]["registered"] = False
        with patch.object(sync, "install", side_effect=lambda h,s:self.assertEqual(s,[])):
            skipped = sync.apply(self.home, sync.selection(doc,None), True)
        self.assertFalse(skipped)
        self.assertEqual(sync.read_json(self.start)["mode"], "always")
        self.assertEqual(sync.read_json(self.widget)["scale"], 1.4)
        self.assertNotIn(sync.CONTEXT, sync.read_json(self.manifest)["dsh"]["profile"]["bundles"])

    def test_invalid_manifest(self):
        d=sync.inventory(self.home)
        d["packages"][sync.WHALE]["settings"]["apiToken"]="example"
        with self.assertRaises(ValueError):
            sync.selection(d,[sync.WHALE])
        with self.assertRaises(ValueError):
            sync.selection(d,["../elsewhere"])

    def test_patch_preserves_peers_and_order(self):
        path=self.profile/"cordis.patch.yml"
        path.write_text("# untouched\n- id: before\n  disabled: true\n- id: plugin-market\n  config:\n    indexes:\n      - https://a.example/index\n# next item\n- id: after\n  disabled: false\n",encoding="utf8")
        val={"plugin-market":{"config":{"indexes":["https://b.example/index","https://a.example/index"]}}}
        sync.write_rows(path,val)
        self.assertIn("# next item", path.read_text())
        self.assertEqual([r["id"] for r in sync.read_rows(path)],["before","plugin-market","after"])
        self.assertEqual(sync.read_rows(path)[1]["config"],val["plugin-market"]["config"])

    def test_index_credentials(self):
        for v in ("https://user:pass@a.example/index","https://a.example/?token=x"):
            with self.assertRaises(ValueError):
                sync.indexes([v])

if __name__=="__main__":
    unittest.main()
