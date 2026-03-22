import requests
import webbrowser
import time
import os
from dotenv import load_dotenv

load_dotenv()

class AuthManager:
    def __init__(self):
        self.domain = os.getenv('AUTH0_DOMAIN')
        print(f"DEBUG: Loaded Domain is: {self.domain}") # Is this printing 'None'?
        
        if self.domain is None:
            raise ValueError("Could not find AUTH0_DOMAIN in .env file!")
        self.client_id = os.getenv('AUTH0_CLIENT_ID')
        self.audience = os.getenv('AUTH0_AUDIENCE')
        self.device_code = None
        self.user_code = None
        self.verification_uri = None
        self.access_token = None
        self.user_info = None
        self.id_token = None

    def start_login(self):
        url = f"https://{self.domain}/oauth/device/code"
        payload = {
            'client_id': self.client_id,
            'scope': 'openid profile email',
            'audience': self.audience
        }
        resp = requests.post(url, data=payload).json()
        self.device_code = resp['device_code']
        self.user_code = resp['user_code']
        self.verification_uri = resp['verification_uri_complete']
        
        # Automatically open the user's browser
        webbrowser.open(self.verification_uri)
        return self.user_code

    def check_token(self):
        url = f"https://{self.domain}/oauth/token"
        payload = {
            'grant_type': 'urn:ietf:params:oauth:grant-type:device_code',
            'device_code': self.device_code,
            'client_id': self.client_id
        }
        resp = requests.post(url, data=payload)
        data = resp.json()
        
        if resp.status_code == 200:
            self.access_token = data.get('access_token')
            # id_token may be present depending on the flow
            self.id_token = data.get('id_token')
            return True
        return False

    def fetch_userinfo(self):
        """Fetch the user's profile from Auth0 `/userinfo` using the access token.

        Returns the user info dict on success, otherwise None.
        """
        if not self.access_token:
            return None
        url = f"https://{self.domain}/userinfo"
        headers = {"Authorization": f"Bearer {self.access_token}"}
        try:
            resp = requests.get(url, headers=headers)
            if resp.status_code == 200:
                self.user_info = resp.json()
                return self.user_info
        except Exception as e:
            print(f"fetch_userinfo failed: {e}")
        return None