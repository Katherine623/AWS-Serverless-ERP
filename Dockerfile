FROM public.ecr.aws/lambda/python:3.12

COPY requirements.txt ${LAMBDA_TASK_ROOT}/requirements.txt
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

COPY app ${LAMBDA_TASK_ROOT}/app
COPY fixtures ${LAMBDA_TASK_ROOT}/fixtures
COPY knowledge ${LAMBDA_TASK_ROOT}/knowledge
COPY web ${LAMBDA_TASK_ROOT}/web

CMD ["app.main.handler"]
