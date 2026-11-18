import unittest, json, os, time, subprocess, urllib.request, urllib.error, sys
from threading import Thread

GATEWAY_SCRIPT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'scripts', 'ad-hoc', 'airoute_gateway.py'))

class GatewayProcess:
    def __init__(self):
        self.proc = None
    def start(self):
        # start the gateway as a background process
        self.proc = subprocess.Popen([sys.executable, GATEWAY_SCRIPT], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        # give it a moment to start
        time.sleep(1)
    def stop(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()

class TestAiRouteGateway(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        PORT = 8001
        cls.base_url = f'http://127.0.0.1:{PORT}'
        # start gateway with custom port
        env = os.environ.copy()
        env['AIRoute_PORT'] = str(PORT)
        env['MOCK_PODMAN'] = '1'
        cls.gateway = subprocess.Popen([sys.executable, GATEWAY_SCRIPT], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        time.sleep(1)
        # authentication header used for all requests
        cls.auth_header = {'Authorization': 'Bearer dummy-token'}

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'gateway') and cls.gateway:
            cls.gateway.terminate()
            try:
                cls.gateway.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.gateway.kill()

    def _post(self, path, payload):
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(self.base_url + path, data=data, method='POST')
        for k, v in self.auth_header.items():
            req.add_header(k, v)
        req.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            self.fail(f'HTTP error {e.code}: {e.read().decode()}')
        except Exception as e:
            self.fail(f'Unexpected error: {e}')

    def test_infer_endpoint(self):
        payload = {'model': 'test-model', 'prompt': 'hello'}
        resp = self._post('/v1/infer', payload)
        self.assertIn('mock', resp)
        self.assertEqual(resp['mock'], 'litellm response')
        self.assertEqual(resp['original'], payload)

    def test_worker_endpoint(self):
        job = {
            'image': 'alpine',
            'cmd': ['echo', 'hello'],
            'env': {},
            'mounts': []
        }
        resp = self._post('/v1/worker', job)
        self.assertIn('stdout', resp)
        self.assertIn('stderr', resp)
        self.assertIn('returncode', resp)
        self.assertEqual(resp['returncode'], 0)
        self.assertIn('hello', resp['stdout'])

if __name__ == '__main__':
    unittest.main()
