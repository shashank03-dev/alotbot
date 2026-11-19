"""Create, but do not launch, a disposable app for the live Mac-agent acceptance check."""
import os
import pathlib
import plistlib
import secrets
import subprocess
import uuid

root = pathlib.Path.home() / 'Library/Application Support/Alotbot/live-tests' / uuid.uuid4().hex
app = root / 'Alotbot Verification.app'
(app / 'Contents/MacOS').mkdir(parents=True)
with (app / 'Contents/Info.plist').open('wb') as handle:
    plistlib.dump({'CFBundleName': 'Alotbot Verification', 'CFBundleIdentifier': 'me.shashankdev.alotbot.verification', 'CFBundleExecutable': 'Verification', 'CFBundlePackageType': 'APPL', 'LSUIElement': True}, handle)
words = ['silver', 'meadow', 'copper', 'orchard', 'cobalt', 'river', 'cedar', 'amber']
(root / 'phrase.txt').write_text(' '.join(secrets.SystemRandom().sample(words, 3)))
subprocess.run(['swiftc', 'mac/Tests/Fixtures/AgentFixture.swift', '-o', str(app / 'Contents/MacOS/Verification')], check=True)
subprocess.run(['codesign', '--force', '--deep', '--sign', '-', str(app)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
print(root)
