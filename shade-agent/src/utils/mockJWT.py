import jwt
import time

TEE_SECRET = '64cdf4bd6c6cbfa44ac82ff0d064c6c3485ffb4c89e194a0e0558873f4eee328'

payload = {
    'user_id': 'user.testnet',
    'group_id': 'test_group',
    'exp': int(time.time()) + 3600  # 1h
}
token = jwt.encode(payload, TEE_SECRET, algorithm='HS256')
print(token)