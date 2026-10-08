module.exports = {
  apps: [
    {
      name: "hider-bot",
      script: "hider_bot.py",
      interpreter: "./venv/bin/python3",
      watch: false,
      restart_delay: 5000,
    },
    {
      name: "convert-bot",
      script: "convert_bot.py",
      interpreter: "./venv/bin/python3",
      watch: false,
      restart_delay: 5000,
    },
    {
      name: "upload-bot",
      script: "upload_bot.py",
      interpreter: "./venv/bin/python3",
      watch: false,
      restart_delay: 5000,
    }
  ]
};
