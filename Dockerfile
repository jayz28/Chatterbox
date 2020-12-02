FROM ubuntu:20.04

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    nodejs \
    npm \
    build-essential

WORKDIR /root

COPY . .

RUN make install

ENTRYPOINT ["/bin/bash", "-c"]
CMD ["make server"]
