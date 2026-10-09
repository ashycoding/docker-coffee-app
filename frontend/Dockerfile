FROM nginx:1.27-alpine

# Copy custom Nginx configuration
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Copy frontend static public files
COPY frontend/public/ /usr/share/nginx/html/

# Copy founder image directly from root
#COPY IMG_2099.JPG /usr/share/nginx/html/ashok.jpg
#COPY IMG_2099.JPG /usr/share/nginx/html/IMG_2099.JPG

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
