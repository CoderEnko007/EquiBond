# -*- coding: utf-8 -*-
"""网络降级方案：github.com 不可达但 api.github.com 可用时，用 Git Data API 推送本地最新提交。
用法：python scripts/api_push.py [commit_message]
"""
import base64
import json
import subprocess
import sys

REPO = "CoderEnko007/EquiBond"
API = "https://api.github.com"


def token():
    r = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n",
                       capture_output=True, text=True, timeout=40)
    for line in r.stdout.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1]
    raise RuntimeError("取不到 GitHub 凭据")


def call(tok, method, path, body=None):
    import urllib.request
    req = urllib.request.Request(API + path, method=method)
    req.add_header("Authorization", "Bearer " + tok)
    req.add_header("Accept", "application/vnd.github+json")
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data=data, timeout=40) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    msg = sys.argv[1] if len(sys.argv) > 1 else "update"
    tok = token()

    # 1. 远端 ref
    ref = call(tok, "GET", "/repos/%s/git/ref/heads/main" % REPO)
    base_sha = ref["object"]["sha"]
    commit = call(tok, "GET", "/repos/%s/git/commits/%s" % (REPO, base_sha))
    base_tree = commit["tree"]["sha"]
    print("远端 main:", base_sha[:10])

    # 2. 本地最新提交与远端的差异文件
    diff = subprocess.run(["git", "diff", "--name-only", base_sha, "HEAD"],
                          capture_output=True, text=True).stdout.split()
    if not diff:
        print("远端已是最新，无需推送")
        return
    print("待推送文件:", diff)

    # 3. 建 blob
    tree_items = []
    for p in diff:
        with open(p, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        blob = call(tok, "POST", "/repos/%s/git/blobs" % REPO,
                    {"content": b64, "encoding": "base64"})
        tree_items.append({"path": p, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print("  blob:", p)

    # 4. 树 + 提交 + 移动 ref
    tree = call(tok, "POST", "/repos/%s/git/trees" % REPO,
                {"base_tree": base_tree, "tree": tree_items})
    new = call(tok, "POST", "/repos/%s/git/commits" % REPO,
               {"message": msg, "tree": tree["sha"], "parents": [base_sha]})
    call(tok, "PATCH", "/repos/%s/git/refs/heads/main" % REPO, {"sha": new["sha"], "force": False})
    print("远端已更新:", new["sha"][:10], "->", msg)


if __name__ == "__main__":
    main()
