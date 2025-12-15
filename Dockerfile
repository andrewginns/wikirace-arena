FROM python:3.9

# install nodejs and npm
ENV PYTHONUNBUFFERED 1
RUN apt-get update && \
    apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g yarn

#Set up a new user named "user" with user ID 1000
RUN useradd -m -u 1000 user

# Switch to the "user" user
USER user

# Set home to the user's home directory
ENV HOME=/home/user \
	PATH=/home/user/.local/bin:$PATH

# Set the working directory to the user's home directory
WORKDIR $HOME/app

COPY pyproject.toml uv.lock ./

# Python deps (uv)
RUN pip install --no-cache-dir --upgrade pip
RUN pip install --no-cache-dir uv
RUN uv sync --frozen --no-install-project

# Copy the current directory contents into the container at $HOME/app setting the owner to the user
COPY --chown=user . $HOME/app

ENV VITE_ENV=production

RUN yarn install
RUN yarn build

# Build the wikihop.db locally from the dataset.
RUN uv run python get_wikihop.py --output wikihop.db

ENV WIKISPEEDIA_DB_PATH=/home/user/app/wikihop.db


CMD ["uv", "run", "uvicorn", "api:app", "--host", "0.0.0.0", "--port", "7860"]


# # Download a checkpoint
# RUN mkdir content
# ADD --chown=user https://<SOME_ASSET_URL> content/<SOME_ASSET_NAME>
