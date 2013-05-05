module.exports = {
  JENKINS_USER: 'Nodejs-Jenkins',
  JENKINS_API_TOKEN: '',
  JENKINS_HOSTNAME: 'jenkins.nodejs.org',
  JENKINS_PORT: 8080,
  REPO_PATH: '/home/tjfontaine/node/',
  UDP: 'localhost:8001',
  CHECK_INTERVAL: 15 * 1000,
  BIND_PORT: 80,
  BIND_IP: '0.0.0.0',
  GOOGLE_USERNAME: '',
  GOOGLE_PASSWORD: '',
  CLA_KEY: '',
  GITHUB_AUTH: '',
  WHITELIST: {},
  LOGS: [{
    type: 'rotating-file',
    path: 'jankins.log',
    period: '1d',
    count: 5,
  }],
  DB: 'jankins.db',
};
