cd /Users/yaron/AGI/MetaMe && npm version patch --no-git-tag-version && git add package.json
  plugin/.claude-plugin/plugin.json && git commit -m "bump $(node -p
  'require("./package.json").version')" && npm publish --otp=`<OTP>` && git push
