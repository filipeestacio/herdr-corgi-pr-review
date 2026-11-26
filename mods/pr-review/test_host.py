"""Run: python3 test_host.py  (the git host behind a remote or a link)"""
import host

assert host.remote_host("git@gitlab.com:g/p.git") == "gitlab.com"
assert host.remote_host("ssh://git.example.com/g/p.git") == "git.example.com"
assert host.remote_host("https://github.com/o/r.git") == "github.com"
assert host.remote_host("") is None
assert host.remote_host("not a url") is None

assert host.host_of("git@github.com:o/r.git") == host.GITHUB
assert host.host_of("https://gitlab.com/g/p.git") == host.GITLAB
assert host.host_of("https://gitlab.example.com/g/p.git") == host.GITLAB
assert host.host_of("git@git.example.com:g/p.git") is None
assert host.host_of("git@git.example.com:g/p.git", {"host": "gitlab"}) == host.GITLAB

assert host.parse_remote("git@gitlab.com:group/sub/project.git") == {"host": host.GITLAB, "hostname": "gitlab.com", "repo": "group/sub/project"}
assert host.parse_remote("https://github.com/o/r.git") == {"host": host.GITHUB, "hostname": "github.com", "repo": "o/r"}
assert host.parse_remote("https://gitlab.example.com/g/p") == {"host": host.GITLAB, "hostname": "gitlab.example.com", "repo": "g/p"}
assert host.parse_remote("https://github.com/o") is None

assert host.parse_link("https://github.com/o/r/pull/12") == {"host": host.GITHUB, "hostname": "github.com", "repo": "o/r", "number": 12}
assert host.parse_link("https://github.com/o/r/pull/12/files") == {"host": host.GITHUB, "hostname": "github.com", "repo": "o/r", "number": 12}
assert host.parse_link("https://gitlab.com/g/sub/p/-/merge_requests/7") == {"host": host.GITLAB, "hostname": "gitlab.com", "repo": "g/sub/p", "number": 7}
assert host.parse_link("https://gitlab.com/g/sub/p/-/merge_requests/7/diffs") == {"host": host.GITLAB, "hostname": "gitlab.com", "repo": "g/sub/p", "number": 7}
assert host.parse_link("https://gitlab.com/g/p/merge_requests/7") is None
assert host.parse_link("https://example.com/x") is None

assert host.web_url({"host": host.GITHUB, "hostname": "github.com", "repo": "o/r", "number": 12}) == "https://github.com/o/r/pull/12"
assert host.web_url({"host": host.GITLAB, "hostname": "gitlab.com", "repo": "g/sub/p", "number": 7}) == "https://gitlab.com/g/sub/p/-/merge_requests/7"
assert host.web_url(None) is None
print("ok")
