module.exports = {
  apps: [
    ["connection", "service_bot.py", "CONNECTION", "NightBox Connection"],
    ["terabox", "convert_bot.py", "TERABOX", "TeraBox"],
    ["diskwala", "convert_bot.py", "DISKWALA", "Diskwala"],
    ["nightbox-to-nightbox", "convert_bot.py", "NIGHTBOX_TO_NIGHTBOX", "NightBox to NightBox"],
    ["nightheast-to-nightbox", "convert_bot.py", "NIGHTHEAST_TO_NIGHTBOX", "Nightheast to NightBox"],
    ["upload", "upload_bot.py", "UPLOAD", "NightBox Upload"],
  ].map(([name, script, kind, label]) => ({
    name: `nightbox-${name}-bot`,
    script,
    interpreter: "./venv/bin/python3",
    watch: false,
    autorestart: true,
    restart_delay: 5000,
    env: { BOT_KIND: kind, BOT_LABEL: label },
  })),
};
