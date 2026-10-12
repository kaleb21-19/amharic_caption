"""Afaan Oromo text clean-up (1.10.20): no language tag in the transcript,
and a full stop / comma glued between two words splits them (time shared)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
import ethio_srt as E  # noqa: E402

out = E._split_glued_punct([("arabsitu.tokuma", 1.0, 2.0), ("tokkot.", 2.0, 3.0), ("2.5", 3.0, 4.0),
                            ("dhangala'aa", 4.0, 5.0), ("a,b.c", 5.0, 6.0)])
assert [w[0] for w in out] == ["arabsitu.", "tokuma", "tokkot.", "2.5", "dhangala'aa", "a,", "b.", "c"], out
assert out[0][1] == 1.0 and out[1][2] == 2.0 and abs(out[0][2] - 1.6) < 1e-9, out[:2]
assert E._strip_lang_tags("[ORM] fakkii kana") == "fakkii kana"
assert E._strip_lang_tags("fakkii [ORM] kana") == "fakkii kana"
print("ALL PASS")
