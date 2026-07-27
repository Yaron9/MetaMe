import importlib.util
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("quick_validate.py")
SPEC = importlib.util.spec_from_file_location("quick_validate", MODULE_PATH)
QUICK_VALIDATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(QUICK_VALIDATE)


class QuickValidateFrontmatterTests(unittest.TestCase):
    def validate(self, frontmatter):
        with tempfile.TemporaryDirectory() as temp_dir:
            skill_dir = Path(temp_dir)
            (skill_dir / "SKILL.md").write_text(
                f"---\n{frontmatter}---\n\n# Test\n",
                encoding="utf-8",
            )
            return QUICK_VALIDATE.validate_skill(skill_dir)

    def test_accepts_runtime_boolean_fields(self):
        valid, message = self.validate(
            "name: test-skill\n"
            "description: Test skill.\n"
            "disable-model-invocation: true\n"
            "needs_browser: true\n"
        )

        self.assertTrue(valid, message)

    def test_rejects_non_boolean_runtime_field(self):
        valid, message = self.validate(
            "name: test-skill\n"
            "description: Test skill.\n"
            "disable-model-invocation: yes-please\n"
        )

        self.assertFalse(valid)
        self.assertIn("must be a boolean", message)


if __name__ == "__main__":
    unittest.main()
